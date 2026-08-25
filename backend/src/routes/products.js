import { Router } from "express";
import multer from "multer";
import { prisma } from "../lib/prisma.js";
import {
  validateProductInput,
  getApprovalRequirementFailures,
  EDITABLE_FIELDS,
  COMMERCE_CRITICAL_FIELDS,
} from "../lib/productValidation.js";
import { isSkuConflictError, sendSkuConflict } from "../lib/prismaErrors.js";
import { validateGeneratedProductPrice } from "../lib/intelligence/opportunityService.js";
import { MAX_IMPORT_FILE_SIZE_BYTES, importCatalogFile } from "../lib/catalogImport.js";
import { crawlSite } from "../lib/crawler/crawlSite.js";
import { crawlLimiter, uploadLimiter } from "../lib/rateLimit.js";

export const productsRouter = Router({ mergeParams: true });

const STATUS_VALUES = ["PENDING_REVIEW", "APPROVED", "REJECTED"];
// Defensive cap on the merchant catalog list, matching the bound already
// applied to the Order list — not because a real problem was observed, just
// consistency against unbounded growth.
const MAX_LIST_RESULTS = 500;
// Cheap defense-in-depth ahead of the SSRF checks — no legitimate storefront
// URL is anywhere near this long.
const MAX_CRAWL_URL_LENGTH = 2048;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_FILE_SIZE_BYTES },
});

function handleFileUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "FILE_TOO_LARGE", maxBytes: MAX_IMPORT_FILE_SIZE_BYTES });
      }
      console.error("File upload error:", err);
      return res.status(400).json({ error: "UPLOAD_FAILED" });
    }
    next();
  });
}

async function loadProduct(req, res, next) {
  const product = await prisma.product.findFirst({
    where: { id: req.params.productId, merchantId: req.merchant.id },
  });

  if (!product) {
    return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
  }

  req.product = product;
  next();
}

productsRouter.get("/", async (req, res) => {
  const { status } = req.query;

  if (status && !STATUS_VALUES.includes(status)) {
    return res.status(400).json({ error: "INVALID_STATUS_FILTER" });
  }

  const products = await prisma.product.findMany({
    where: {
      merchantId: req.merchant.id,
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: MAX_LIST_RESULTS,
  });

  res.json(products);
});

productsRouter.post("/", async (req, res) => {
  // Manual creation requires complete commerce fields up front, since the merchant is
  // entering the data directly. Future CRAWL/FILE_UPLOAD ingestion will intentionally
  // allow incomplete records and must not pass requireCommerceFields here.
  const { errors, data } = validateProductInput(req.body || {}, { partial: false, requireCommerceFields: true });

  if (errors.length > 0) {
    return res.status(422).json({ error: "VALIDATION_FAILED", details: errors });
  }

  try {
    const product = await prisma.product.create({
      data: {
        ...data,
        merchantId: req.merchant.id,
        sourceType: "MANUAL",
        status: "PENDING_REVIEW",
      },
    });

    res.status(201).json(product);
  } catch (error) {
    if (isSkuConflictError(error)) {
      return sendSkuConflict(res);
    }
    console.error("Failed to create product:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

productsRouter.post("/import", uploadLimiter, handleFileUpload, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "FILE_REQUIRED" });
  }

  const format = req.body.format;
  if (format !== "csv" && format !== "json") {
    return res.status(400).json({ error: "INVALID_FORMAT" });
  }

  try {
    const result = await importCatalogFile({
      buffer: req.file.buffer,
      format,
      merchantId: req.merchant.id,
    });

    if (result.batchError) {
      return res.status(400).json(result.batchError);
    }

    res.status(200).json(result.summary);
  } catch (error) {
    console.error("Catalog import failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

productsRouter.post("/crawl", crawlLimiter, async (req, res) => {
  const url = req.body?.url;
  if (typeof url !== "string" || url.trim() === "" || url.length > MAX_CRAWL_URL_LENGTH) {
    return res.status(400).json({ error: "INVALID_URL" });
  }

  try {
    const result = await crawlSite({ url: url.trim(), merchantId: req.merchant.id });

    if (result.batchError) {
      const status = result.batchError.error === "CRAWL_IN_PROGRESS" ? 409 : 400;
      return res.status(status).json(result.batchError);
    }

    res.status(200).json(result.summary);
  } catch (error) {
    console.error("Website crawl failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

productsRouter.get("/:productId", loadProduct, (req, res) => {
  res.json(req.product);
});

productsRouter.patch("/:productId", loadProduct, async (req, res) => {
  const body = req.body || {};
  const disallowed = Object.keys(body).filter((key) => !EDITABLE_FIELDS.includes(key));
  if (disallowed.length > 0) {
    return res.status(422).json({ error: "VALIDATION_FAILED", details: [`fields not editable: ${disallowed.join(", ")}`] });
  }

  const { errors, data } = validateProductInput(body, { partial: true });

  if (errors.length > 0) {
    return res.status(422).json({ error: "VALIDATION_FAILED", details: errors });
  }

  const product = req.product;

  const changedFields = Object.keys(data).filter((key) => {
    const currentValue = product[key];
    const nextValue = data[key];

    if (key === "price") {
      const currentPrice = currentValue === null ? null : Number(currentValue);
      const nextPrice = nextValue === null ? null : Number(nextValue);
      return currentPrice !== nextPrice;
    }

    return currentValue !== nextValue;
  });

  // Growth Agent correctness fix — an AI-generated product's price must
  // keep obeying its originating opportunity's demand-supported pricing
  // policy for the rest of its life, not just at the moment it was drafted.
  // No-ops entirely for MANUAL/CRAWL/FILE_UPLOAD products (see
  // validateGeneratedProductPrice). Checked BEFORE the write — a rejected
  // price change saves nothing.
  if (changedFields.includes("price") && data.price !== null) {
    const priceCheck = await validateGeneratedProductPrice({ product, candidatePrice: Number(data.price) });
    if (priceCheck.status === "UNVERIFIABLE") {
      return res.status(422).json({ error: "DEMAND_POLICY_UNVERIFIABLE" });
    }
    if (priceCheck.status === "CHECKED" && priceCheck.errors.length > 0) {
      return res.status(422).json({ error: "PRICE_VIOLATES_DEMAND_POLICY", details: priceCheck.errors });
    }
  }

  let nextStatus = product.status;

  if (changedFields.length > 0) {
    if (product.status === "APPROVED" && changedFields.some((f) => COMMERCE_CRITICAL_FIELDS.includes(f))) {
      nextStatus = "PENDING_REVIEW";
    } else if (product.status === "REJECTED") {
      nextStatus = "PENDING_REVIEW";
    }
  }

  try {
    const updated = await prisma.product.update({
      where: { id: product.id },
      data: {
        ...data,
        status: nextStatus,
      },
    });

    res.json(updated);
  } catch (error) {
    if (isSkuConflictError(error)) {
      return sendSkuConflict(res);
    }
    console.error("Failed to update product:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

productsRouter.delete("/:productId", loadProduct, async (req, res) => {
  await prisma.product.delete({ where: { id: req.product.id } });
  res.status(200).json({ deleted: true, id: req.product.id });
});

productsRouter.post("/:productId/approve", loadProduct, async (req, res) => {
  const product = req.product;

  if (product.status !== "PENDING_REVIEW") {
    return res.status(409).json({ error: "INVALID_STATUS_TRANSITION", from: product.status, to: "APPROVED" });
  }

  const missing = getApprovalRequirementFailures(product);

  if (missing.length > 0) {
    return res.status(422).json({ error: "APPROVAL_REQUIREMENTS_NOT_MET", missing });
  }

  // Growth Agent correctness fix — the final, unbypassable gate. An
  // AI-generated product must never become APPROVED/purchasable unless
  // SmartCart can verify its price against its originating demand
  // evidence — fail-closed (DEMAND_POLICY_UNVERIFIABLE), never fail-open,
  // when that evidence can no longer be loaded at all.
  const priceCheck = await validateGeneratedProductPrice({
    product,
    candidatePrice: product.price !== null ? Number(product.price) : null,
  });
  if (priceCheck.status === "UNVERIFIABLE") {
    return res.status(422).json({ error: "DEMAND_POLICY_UNVERIFIABLE" });
  }
  if (priceCheck.status === "CHECKED" && priceCheck.errors.length > 0) {
    return res.status(422).json({ error: "PRICE_VIOLATES_DEMAND_POLICY", details: priceCheck.errors });
  }

  const updated = await prisma.product.update({
    where: { id: product.id },
    data: { status: "APPROVED" },
  });

  res.json(updated);
});

productsRouter.post("/:productId/reject", loadProduct, async (req, res) => {
  const product = req.product;

  if (product.status !== "PENDING_REVIEW") {
    return res.status(409).json({ error: "INVALID_STATUS_TRANSITION", from: product.status, to: "REJECTED" });
  }

  const updated = await prisma.product.update({
    where: { id: product.id },
    data: { status: "REJECTED" },
  });

  res.json(updated);
});
