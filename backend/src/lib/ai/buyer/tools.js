import {
  searchProducts,
  getApprovedProductById,
  getApprovedProductAvailability,
  getMerchantById,
} from "../../commerceService.js";
import { isValidAvailability, parsePriceRange, parsePagination } from "../../commerceValidation.js";

// Neutral (provider-independent) tool schemas. provider.js translates these
// into whatever shape the active vendor SDK expects — nothing here is
// Gemini-specific. Exactly four tools exist, all read-only, all backed by
// commerceService: there is no arbitrary-HTTP tool, no SQL tool, no
// merchant-management tool, and no write/mutation tool of any kind.
// Recommendation turns retrieve a small bounded candidate set rather than an
// unbounded/large page — the buyer agent ranks/selects a handful of these to
// actually show (see buyerAgent.js), it never displays a raw full page.
export const MAX_CANDIDATE_LIMIT = 10;

export const TOOL_DEFINITIONS = [
  {
    name: "search_products",
    description:
      "Search approved products in the marketplace catalog. Returns only real, merchant-approved products — never invents results. Use whenever the customer describes something they want to find or browse. Returns a bounded set of up to 10 candidates for you to evaluate and rank; you decide which to actually show the customer via respond_to_customer's productIds.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search over product name, description, and category." },
        merchantId: { type: "string", description: "Restrict results to one specific merchant, only if the customer named one." },
        category: { type: "string", description: "Exact product category (case-insensitive)." },
        minPrice: { type: "string", description: 'Minimum price as a decimal string, e.g. "500.00".' },
        maxPrice: { type: "string", description: 'Maximum price as a decimal string, e.g. "2000.00".' },
        availability: { type: "string", enum: ["IN_STOCK", "OUT_OF_STOCK", "UNKNOWN"] },
        limit: { type: "integer", description: "Max candidates to retrieve (capped at 10 regardless of what you ask for)." },
      },
    },
  },
  {
    name: "get_product",
    description:
      "Fetch full details for one specific approved product by its exact ID. Only ever use a productId that appeared in an earlier search_products or get_product result in THIS conversation — never a guessed or remembered-from-elsewhere ID.",
    parametersJsonSchema: {
      type: "object",
      properties: { productId: { type: "string" } },
      required: ["productId"],
    },
  },
  {
    name: "check_availability",
    description:
      "Check current stock availability and quantity for one approved product by its exact ID. Only ever use a productId that appeared in an earlier tool result in THIS conversation.",
    parametersJsonSchema: {
      type: "object",
      properties: { productId: { type: "string" } },
      required: ["productId"],
    },
  },
  {
    name: "get_merchant",
    description: "Fetch minimal public info (id, name) for a merchant that currently has at least one approved product.",
    parametersJsonSchema: {
      type: "object",
      properties: { merchantId: { type: "string" } },
      required: ["merchantId"],
    },
  },
];

function cleanString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Each executor receives (args, context) and returns a plain JSON-serializable
// result or { error }. `context.knownProductIds` is a Set the agent maintains
// of every product ID that has genuinely appeared in one of THIS
// conversation's own tool results so far. get_product/check_availability
// refuse to even attempt a lookup for an ID outside that set — a hallucinated
// ID can never reach commerceService pretending to be a legitimate follow-up
// reference. commerceService's own APPROVED-only check remains the real
// authorization boundary underneath this; this is a cheap extra guard in
// front of it, not a replacement.
export const TOOL_EXECUTORS = {
  async search_products(args) {
    if (args.availability !== undefined && !isValidAvailability(args.availability)) {
      return { error: "INVALID_AVAILABILITY_FILTER" };
    }

    const priceRange = parsePriceRange(args.minPrice, args.maxPrice);
    if (priceRange.error) {
      return { error: "INVALID_PRICE_RANGE" };
    }

    let limit = MAX_CANDIDATE_LIMIT;
    if (args.limit !== undefined) {
      const pagination = parsePagination(String(args.limit), undefined);
      if (pagination.error) return { error: "INVALID_PAGINATION" };
      limit = Math.min(pagination.limit, MAX_CANDIDATE_LIMIT);
    }

    return searchProducts({
      query: cleanString(args.query),
      merchantId: cleanString(args.merchantId),
      category: cleanString(args.category),
      availability: args.availability,
      minPrice: priceRange.minPrice,
      maxPrice: priceRange.maxPrice,
      limit,
      offset: 0,
    });
  },

  async get_product(args, context) {
    if (!isNonEmptyString(args.productId)) {
      return { error: "INVALID_ARGUMENTS", message: "productId is required." };
    }
    if (!context.knownProductIds.has(args.productId)) {
      return { error: "UNKNOWN_PRODUCT_REFERENCE", message: "That product was not part of this conversation's own results." };
    }
    const product = await getApprovedProductById(args.productId);
    return product || { error: "PRODUCT_NOT_FOUND" };
  },

  async check_availability(args, context) {
    if (!isNonEmptyString(args.productId)) {
      return { error: "INVALID_ARGUMENTS", message: "productId is required." };
    }
    if (!context.knownProductIds.has(args.productId)) {
      return { error: "UNKNOWN_PRODUCT_REFERENCE", message: "That product was not part of this conversation's own results." };
    }
    const result = await getApprovedProductAvailability(args.productId);
    return result || { error: "PRODUCT_NOT_FOUND" };
  },

  async get_merchant(args) {
    if (!isNonEmptyString(args.merchantId)) {
      return { error: "INVALID_ARGUMENTS", message: "merchantId is required." };
    }
    const merchant = await getMerchantById(args.merchantId);
    return merchant || { error: "MERCHANT_NOT_FOUND" };
  },
};

// Collects every product ID present in a tool result so the agent can grow
// its per-conversation "known IDs" grounding set.
export function extractProductIds(toolName, result) {
  if (!result || result.error) return [];
  if (toolName === "search_products" && Array.isArray(result.products)) {
    return result.products.map((p) => p.id).filter(Boolean);
  }
  if (toolName === "get_product" && result.id) {
    return [result.id];
  }
  return [];
}
