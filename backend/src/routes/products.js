import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import {
  validateProductInput,
  getApprovalRequirementFailures,
  EDITABLE_FIELDS,
  COMMERCE_CRITICAL_FIELDS,
} from "../lib/productValidation.js";

export const productsRouter = Router({ mergeParams: true });

const STATUS_VALUES = ["PENDING_REVIEW", "APPROVED", "REJECTED"];

function isSkuConflictError(error) {
  if (error?.code !== "P2002") return false;
  const target = error.meta?.target;
  return Array.isArray(target) ? target.includes("sku") : String(target || "").includes("sku");
}

function sendSkuConflict(res) {
  return res.status(409).json({
    error: "SKU_ALREADY_EXISTS",
    field: "sku",
    message: "A product with this SKU already exists for this merchant.",
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
  });

  res.json(products);
});

productsRouter.post("/", async (req, res) => {
  // Manual creation requires complete commerce fields up front, since the merchant is
  // entering the data directly. Future CRAWL/FILE_UPLOAD ingestion will intentionally
  // allow incomplete records and must not pass requireCommerceFields here.
  const { errors, data } = validateProductInput(req.body, { partial: false, requireCommerceFields: true });

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
    console.error("Failed to create product:", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

productsRouter.get("/:productId", loadProduct, (req, res) => {
  res.json(req.product);
});

productsRouter.patch("/:productId", loadProduct, async (req, res) => {
  const disallowed = Object.keys(req.body).filter((key) => !EDITABLE_FIELDS.includes(key));
  if (disallowed.length > 0) {
    return res.status(422).json({ error: "VALIDATION_FAILED", details: [`fields not editable: ${disallowed.join(", ")}`] });
  }

  const { errors, data } = validateProductInput(req.body, { partial: true });

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
    console.error("Failed to update product:", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
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
