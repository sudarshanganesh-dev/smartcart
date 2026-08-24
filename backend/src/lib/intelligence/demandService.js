import { prisma } from "../prisma.js";
import { searchProducts } from "../commerceService.js";
import { toMinorUnits, fromMinorUnits } from "../ai/buyer/cart.js";

// Phase 7 — Revenue Recovery. This file is the ONLY place a DemandEvent is
// ever written. There is no public write endpoint for it — every call here
// comes from server-side instrumentation of a real buyer-agent outcome
// (buyerAgent.js). Never trust/accept a merchantId, groupKey, or
// estimatedValue from a client; every value here is derived from trusted
// commerceService data or from the conversation's own trusted state.

export const MIN_SIGNAL_THRESHOLD = 3;
// Safety cap against a generic query fanning a single demand signal out
// across an unreasonable number of merchants — this is a defense-in-depth
// bound, not expected to be hit in normal use.
const MAX_ATTRIBUTED_MERCHANTS = 5;

function normalizeIntent(text) {
  return text
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

// Fixed, human-readable ceilings — deliberately NOT an LLM/fuzzy clustering.
// "under 100" and "under 95" both fall in the same "<=100" band (same
// opportunity); "under 100" and "under 500" fall in different bands
// (distinct opportunities) — this is the exact fix for the reported
// cake-under-100-vs-cake-under-500 collision.
export const BUDGET_BAND_CEILINGS = [100, 250, 500, 1000, 2000, 5000, 10000];

export function budgetBand(price) {
  if (price == null) return "none";
  const value = Number(price);
  for (const ceiling of BUDGET_BAND_CEILINGS) {
    if (value <= ceiling) return `<=${ceiling}`;
  }
  return `>${BUDGET_BAND_CEILINGS[BUDGET_BAND_CEILINGS.length - 1]}`;
}

// Deterministic, computed once at write time — no lookup required. Product-
// specific reasons key on the exact product (a budget band is meaningless
// there — the demand is about ONE specific item, not a price range);
// text-based reasons key on a normalized (never fuzzy/ML) version of the
// category or search query, PLUS the customer's budget band(s) so a
// materially different price intent never collides with another.
export function computeGroupKey({ merchantId, reason, category, query, productId, minPrice, maxPrice }) {
  if (reason === "OUT_OF_STOCK" || reason === "INSUFFICIENT_STOCK") {
    return `${merchantId}|${reason}|${productId}`;
  }
  const intent = normalizeIntent(category || query || "");
  let key = `${merchantId}|${reason}|${intent}|max:${budgetBand(maxPrice)}`;
  if (minPrice != null) {
    key += `|min:${budgetBand(minPrice)}`;
  }
  return key;
}

// Decision 3: never fan a demand signal out to every merchant. A merchant is
// only attributed when there is real, server-discovered evidence connecting
// the failure to their catalog — discovered by relaxing ONLY the price
// constraint (never the category/query, since that's what defines
// "relevant") and seeing who actually has something. If nobody does, this
// is a completely unattributable marketplace-wide gap and nothing is
// recorded at all.
export async function attributeNoMatchMerchants({ merchantId, category, query }) {
  if (merchantId) {
    const result = await searchProducts({ merchantId, category, query, limit: 1, offset: 0 });
    return result.products.length > 0 ? [merchantId] : [];
  }
  const result = await searchProducts({ category, query, limit: 10, offset: 0 });
  const distinctMerchantIds = [...new Set(result.products.map((p) => p.merchant.id))];
  return distinctMerchantIds.slice(0, MAX_ATTRIBUTED_MERCHANTS);
}

function decimalMultiply(decimalString, qty) {
  return fromMinorUnits(toMinorUnits(decimalString) * qty);
}

async function writeOne({ merchantId, conversationId, reason, groupKey, fields, state }) {
  if (state.recordedDemandGroupKeys.has(groupKey)) return; // in-memory fast path

  try {
    await prisma.demandEvent.create({
      data: { merchantId, conversationId, reason, groupKey, ...fields },
    });
  } catch (error) {
    // Durable dedup guarantee (@@unique([conversationId, groupKey])) — a
    // concurrent/retry write hitting the constraint means this exact demand
    // was already recorded, not an application error.
    if (error.code !== "P2002") {
      console.error("[demand-service] failed to record demand event:", error.message);
      return;
    }
  }

  state.recordedDemandGroupKeys.add(groupKey);

  // Decision 1: an Opportunity only becomes visible once at least
  // MIN_SIGNAL_THRESHOLD distinct (deduplicated) conversations have hit the
  // same merchant-attributable group.
  const count = await prisma.demandEvent.count({ where: { merchantId, groupKey } });
  const existing = await prisma.opportunity.findUnique({ where: { merchantId_groupKey: { merchantId, groupKey } } });

  if (existing) {
    await prisma.opportunity.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } });
  } else if (count >= MIN_SIGNAL_THRESHOLD) {
    try {
      await prisma.opportunity.create({ data: { merchantId, groupKey, reason, status: "OPEN" } });
    } catch (error) {
      if (error.code !== "P2002") throw error; // lost a create race to a concurrent request — fine, it exists now
    }
  }
}

// Called from buyerAgent.js when a search_products call returns zero
// candidates. `merchantId` is only passed when the customer explicitly
// named one.
export async function recordNoMatchDemandEvent({ conversationId, merchantId, category, query, minPrice, maxPrice }, state) {
  const merchantIds = await attributeNoMatchMerchants({ merchantId, category, query });
  for (const attributedMerchantId of merchantIds) {
    const groupKey = computeGroupKey({ merchantId: attributedMerchantId, reason: "NO_MATCH", category, query, minPrice, maxPrice });
    await writeOne({
      merchantId: attributedMerchantId,
      conversationId,
      reason: "NO_MATCH",
      groupKey,
      fields: {
        queryText: category ? null : (query ? query.slice(0, 200) : null),
        category: category || null,
        minPrice: minPrice ?? null,
        maxPrice: maxPrice ?? null,
        budgetBand: budgetBand(maxPrice),
        // Decision 8: NO_MATCH — estimatedValue = maxPrice if it exists, else null.
        estimatedValue: maxPrice ?? null,
      },
      state,
    });
  }
}

// Called from buyerAgent.js when show_more_products resolves with nothing
// unseen left. Attributed only to the merchant(s) actually represented
// among the active search context's own candidates — never fanned out
// beyond that real evidence.
export async function recordNoMoreOptionsDemandEvent({ conversationId, searchContext }, state) {
  if (!searchContext) return;
  const candidateList = Object.values(searchContext.candidates || {});
  const merchantIds = [...new Set(candidateList.map((p) => p.merchant?.id).filter(Boolean))];
  const filters = searchContext.filters || {};
  // Decision 8: NO_MORE_OPTIONS — estimatedValue = maxPrice only if a
  // defensible customer budget exists on the search that led here.
  const estimatedValue = filters.maxPrice ?? null;

  for (const merchantId of merchantIds) {
    const groupKey = computeGroupKey({
      merchantId,
      reason: "NO_MORE_OPTIONS",
      category: filters.category,
      query: filters.query,
      minPrice: filters.minPrice,
      maxPrice: filters.maxPrice,
    });
    await writeOne({
      merchantId,
      conversationId,
      reason: "NO_MORE_OPTIONS",
      groupKey,
      fields: {
        queryText: filters.category ? null : (filters.query ? filters.query.slice(0, 200) : null),
        category: filters.category || null,
        minPrice: filters.minPrice ?? null,
        maxPrice: filters.maxPrice ?? null,
        budgetBand: budgetBand(filters.maxPrice),
        estimatedValue,
      },
      state,
    });
  }
}

// Called from buyerAgent.js right after a cart-tool call fails with
// OUT_OF_STOCK or QUANTITY_EXCEEDS_STOCK (mapped to INSUFFICIENT_STOCK
// here). `product` is the freshly re-fetched, trusted commerceService DTO;
// `requestedQuantity` is the actual attempted total quantity for this cart
// action (never hardcoded to 1).
export async function recordStockDemandEvent(
  { conversationId, cartErrorCode, product, requestedQuantity, availableQuantity },
  state
) {
  const reason = cartErrorCode === "OUT_OF_STOCK" ? "OUT_OF_STOCK" : "INSUFFICIENT_STOCK";
  const groupKey = computeGroupKey({ merchantId: product.merchant.id, reason, productId: product.id });

  let estimatedValue = null;
  if (reason === "OUT_OF_STOCK") {
    // Decision 8: OUT_OF_STOCK — trusted price × the actual attempted
    // quantity (default 1 only because that's what was actually attempted).
    estimatedValue = decimalMultiply(product.price, requestedQuantity);
  } else if (reason === "INSUFFICIENT_STOCK" && typeof availableQuantity === "number") {
    // Decision 8: INSUFFICIENT_STOCK — only the shortfall counts as missed
    // demand, never the portion that could still be fulfilled.
    const shortfall = Math.max(requestedQuantity - availableQuantity, 0);
    estimatedValue = shortfall > 0 ? decimalMultiply(product.price, shortfall) : null;
  }

  await writeOne({
    merchantId: product.merchant.id,
    conversationId,
    reason,
    groupKey,
    fields: {
      requestedQuantity,
      productId: product.id,
      availableQuantity: typeof availableQuantity === "number" ? availableQuantity : null,
      estimatedValue,
    },
    state,
  });
}
