import { Router } from "express";
import { searchProducts, getApprovedProductById, getApprovedProductAvailability, getMerchantById } from "../lib/commerceService.js";
import { isValidAvailability, parsePriceRange, parsePagination } from "../lib/commerceValidation.js";

// Trust boundary: this router is the ONLY thing a future AI buyer talks to.
// It never touches the database directly and never returns anything the
// commerce service didn't already scope to status: "APPROVED".
export const commerceRouter = Router();

function cleanString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

commerceRouter.get("/products", async (req, res) => {
  try {
    const { query, merchantId, category, availability, minPrice, maxPrice, limit, offset } = req.query;

    if (availability !== undefined && !isValidAvailability(availability)) {
      return res.status(400).json({ error: "INVALID_AVAILABILITY_FILTER" });
    }

    const priceRange = parsePriceRange(minPrice, maxPrice);
    if (priceRange.error) {
      return res.status(400).json({ error: "INVALID_PRICE_RANGE" });
    }

    const pagination = parsePagination(limit, offset);
    if (pagination.error) {
      return res.status(400).json({ error: "INVALID_PAGINATION" });
    }

    const result = await searchProducts({
      query: cleanString(query),
      merchantId: cleanString(merchantId),
      category: cleanString(category),
      availability,
      minPrice: priceRange.minPrice,
      maxPrice: priceRange.maxPrice,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    res.json(result);
  } catch (error) {
    // This router is the AI buyer's only backend surface — an unexpected
    // failure here must resolve to a clean JSON error, never hang the
    // request or crash the chat turn that's waiting on it.
    console.error("[commerce] product search failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

commerceRouter.get("/products/:productId/availability", async (req, res) => {
  try {
    const result = await getApprovedProductAvailability(req.params.productId);
    if (!result) {
      return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
    }
    res.json(result);
  } catch (error) {
    console.error("[commerce] availability lookup failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

commerceRouter.get("/products/:productId", async (req, res) => {
  try {
    const product = await getApprovedProductById(req.params.productId);
    if (!product) {
      return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
    }
    res.json(product);
  } catch (error) {
    console.error("[commerce] product lookup failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

commerceRouter.get("/merchants/:merchantId", async (req, res) => {
  try {
    const merchant = await getMerchantById(req.params.merchantId);
    if (!merchant) {
      return res.status(404).json({ error: "MERCHANT_NOT_FOUND" });
    }
    res.json(merchant);
  } catch (error) {
    console.error("[commerce] merchant lookup failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
