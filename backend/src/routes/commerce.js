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
});

commerceRouter.get("/products/:productId/availability", async (req, res) => {
  const result = await getApprovedProductAvailability(req.params.productId);
  if (!result) {
    return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
  }
  res.json(result);
});

commerceRouter.get("/products/:productId", async (req, res) => {
  const product = await getApprovedProductById(req.params.productId);
  if (!product) {
    return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
  }
  res.json(product);
});

commerceRouter.get("/merchants/:merchantId", async (req, res) => {
  const merchant = await getMerchantById(req.params.merchantId);
  if (!merchant) {
    return res.status(404).json({ error: "MERCHANT_NOT_FOUND" });
  }
  res.json(merchant);
});
