import { Prisma } from "@prisma/client";
import { searchProducts } from "../commerceService.js";

// Phase 7 — Conversion Recovery. Deliberately zero Gemini calls: every
// alternative offered to the customer is a real, already-trusted
// commerceService search result, never a model invention. Gemini's only
// role (in buyerAgent.js/systemPrompt.js) is to narrate data this module
// already found and validated.
//
// Decision 4: a stated customer budget is a HARD constraint. Recovery may
// broaden query wording or category scope, but must always keep maxPrice,
// the merchant constraint (if the customer/cart already has one), APPROVED-
// only, and availability/stock truth (IN_STOCK only).

const MAX_ALTERNATIVES = 3;

function sortByPriceAscending(products) {
  return [...products].sort((a, b) => Number(a.price) - Number(b.price));
}

function excludeAndCap(products, excludeIds) {
  const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  return sortByPriceAscending(products.filter((p) => !excluded.has(p.id))).slice(0, MAX_ALTERNATIVES);
}

// Triggered only when a search returned zero results AND the customer
// stated a maxPrice. Tries progressively broader (never price-broader)
// searches: same query+category, then category alone, then merchant-wide —
// always still capped at the customer's real budget.
export async function findPriceAlternative({ merchantId, category, query, maxPrice, excludeIds }) {
  if (!maxPrice) return [];

  const base = {
    merchantId,
    maxPrice: new Prisma.Decimal(maxPrice),
    availability: "IN_STOCK",
    limit: MAX_ALTERNATIVES + excludeIdsSize(excludeIds),
  };

  const attempts = [
    { ...base, query, category },
    { ...base, category },
    { ...base },
  ];

  for (const attempt of attempts) {
    const result = await searchProducts({ ...attempt, offset: 0 });
    const candidates = excludeAndCap(result.products, excludeIds);
    if (candidates.length > 0) return candidates;
  }
  return [];
}

// Triggered when a specific product is OUT_OF_STOCK or the requested
// quantity exceeds stock. The cart is already merchant-locked (Phase 4B),
// so any alternative MUST come from the same merchant or it could never
// actually be added — merchantId here is not optional.
export async function findStockAlternative({ merchantId, category, excludeProductId, excludeIds }) {
  const excluded = new Set(excludeIds instanceof Set ? excludeIds : excludeIds || []);
  excluded.add(excludeProductId);

  const attempts = category
    ? [{ merchantId, category, availability: "IN_STOCK" }, { merchantId, availability: "IN_STOCK" }]
    : [{ merchantId, availability: "IN_STOCK" }];

  for (const attempt of attempts) {
    const result = await searchProducts({ ...attempt, limit: MAX_ALTERNATIVES + excluded.size, offset: 0 });
    const candidates = excludeAndCap(result.products, excluded);
    if (candidates.length > 0) return candidates;
  }
  return [];
}

function excludeIdsSize(excludeIds) {
  if (!excludeIds) return 0;
  return excludeIds instanceof Set ? excludeIds.size : excludeIds.length;
}
