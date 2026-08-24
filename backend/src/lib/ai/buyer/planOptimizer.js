import { toMinorUnits } from "./cart.js";
import { containsKeyword } from "./explain.js";

// The SmartCart Decision Engine's deterministic selector. Gemini explores
// the catalog (search_products) and proposes a plan; this module is what
// actually PICKS the final combination from the real, already-grounded
// products SmartCart found this turn — Gemini's own submitted items are
// just one candidate among the ones considered here, never given special
// priority. Every input here is a trusted commerceService product DTO
// (already APPROVED-only by construction); nothing here ever calls Gemini,
// a paid API, or touches the database — pure in-memory computation.

// Caps chosen so the worst case (8 products, sizes 1-4) is C(8,1..4) = 162
// combinations — sub-millisecond, and small enough that a reported count
// stays meaningful rather than a padded-looking number.
const MAX_COMBINATION_POOL = 8;
const MIN_COMBINATION_SIZE = 1;
const MAX_COMBINATION_SIZE = 4;
// How many ranked candidates the caller will actually try against fresh
// validation — handles the rare case where something changed status
// between this turn's search and validation (see bundleTools.js).
const MAX_RANKED_CANDIDATES = 5;

function isUnavailable(product) {
  return product.availability !== "IN_STOCK" || (product.stockQuantity !== null && product.stockQuantity < 1);
}

// MECE partition of a turn's checked products into unavailable / over
// budget / eligible — every checked product falls into exactly one bucket,
// so eligibleCount + overBudgetCount + unavailableCount always equals
// checkedProducts.length. This is also what makes "eligible" the correct
// input pool for combination search: an individually-over-budget or
// out-of-stock product could never appear in a valid combination anyway.
export function computeCheckedBreakdown(checkedProducts, maxBudget) {
  const maxBudgetMinor = maxBudget != null ? toMinorUnits(String(maxBudget)) : null;
  let unavailableCount = 0;
  let overBudgetCount = 0;
  const eligible = [];

  // Defends against duplicate product IDs regardless of whether the caller
  // already de-duplicated — a real product must only ever count once
  // toward "checked"/"eligible", however many times it was searched.
  const uniqueChecked = [...new Map(checkedProducts.map((product) => [product.id, product])).values()];

  for (const product of uniqueChecked) {
    if (isUnavailable(product)) {
      unavailableCount += 1;
      continue;
    }
    if (maxBudgetMinor != null && toMinorUnits(product.price) > maxBudgetMinor) {
      overBudgetCount += 1;
      continue;
    }
    eligible.push(product);
  }

  return { eligible, eligibleCount: eligible.length, overBudgetCount, unavailableCount };
}

function groupByMerchantAndCurrency(products) {
  const groups = new Map();
  for (const product of products) {
    const key = `${product.merchant.id}|${product.currency}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }
  return [...groups.values()];
}

// Deterministic, reproducible narrowing when a merchant/currency group's
// eligible pool exceeds the cap — cheapest-first, since cheaper items are
// more likely to combine within budget, and this always picks the same
// subset for the same input (never random).
function capPool(products) {
  if (products.length <= MAX_COMBINATION_POOL) return products;
  return [...products].sort((a, b) => toMinorUnits(a.price) - toMinorUnits(b.price)).slice(0, MAX_COMBINATION_POOL);
}

// Standard recursive combination generator — every size-`size` subset of
// `items`, order-preserving, no repeats. Trivial at these bounded sizes.
function* combinationsOfSize(items, size) {
  if (size === 0) {
    yield [];
    return;
  }
  for (let i = 0; i <= items.length - size; i++) {
    for (const rest of combinationsOfSize(items.slice(i + 1), size - 1)) {
      yield [items[i], ...rest];
    }
  }
}

function coverageCount(products, preferences) {
  if (preferences.length === 0) return 0;
  return preferences.filter((preference) => products.some((product) => containsKeyword(product, preference))).length;
}

function coveredPreferences(products, preferences) {
  return preferences.filter((preference) => products.some((product) => containsKeyword(product, preference)));
}

// A real, provable catalog fact (product.category, case/whitespace
// normalized) — never a serving/capacity estimate. Products with no
// category at all are grouped into one shared "uncategorized" bucket
// rather than each counting as trivially "distinct", so missing data can
// never inflate a combination's apparent variety.
function distinctCategoryCount(products) {
  const categories = new Set(
    products.map((product) => (typeof product.category === "string" && product.category.trim() !== "" ? product.category.trim().toLowerCase() : "uncategorized"))
  );
  return categories.size;
}

// Lexicographic comparator, in the exact approved priority order:
// 1. more distinct stated preferences proven wins (never trade coverage for
//    a cheaper/smaller plan)
// 2. ONLY when the customer explicitly asked for variety/a mix (never
//    merely because a group size was stated): more distinct catalog
//    categories wins. This is deliberately NOT a proxy for "serves more
//    people" — it's a direct, honest reading of category diversity, used
//    only when the customer's own words asked for it.
// 3. fewer items wins (never add a product that isn't earning its place)
// 4. lower total price wins (never spend more of the customer's budget than
//    necessary to reach the same result)
// 5. deterministic tie-break on sorted product IDs, so identical inputs
//    always produce the identical output
function compareCombinations(a, b, preferences, varietyRequested) {
  const coverageDiff = coverageCount(b.products, preferences) - coverageCount(a.products, preferences);
  if (coverageDiff !== 0) return coverageDiff;

  if (varietyRequested) {
    const diversityDiff = distinctCategoryCount(b.products) - distinctCategoryCount(a.products);
    if (diversityDiff !== 0) return diversityDiff;
  }

  const itemCountDiff = a.products.length - b.products.length;
  if (itemCountDiff !== 0) return itemCountDiff;

  const priceDiff = a.totalMinor - b.totalMinor;
  if (priceDiff !== 0) return priceDiff;

  const idsA = a.products.map((p) => p.id).sort();
  const idsB = b.products.map((p) => p.id).sort();
  const maxLen = Math.max(idsA.length, idsB.length);
  for (let i = 0; i < maxLen; i++) {
    if (idsA[i] === undefined) return -1;
    if (idsB[i] === undefined) return 1;
    if (idsA[i] < idsB[i]) return -1;
    if (idsA[i] > idsB[i]) return 1;
  }
  return 0;
}

// The Decision Engine's core: given every real product SmartCart checked
// this turn, the customer's stated preferences, and their stated budget
// (both already format-validated, never raw free text), returns a ranked
// list of valid candidate plans plus the real counts behind SEARCH/FILTER.
// Hard gates enforced here (never relaxed to gain preference coverage):
// approved (guaranteed by construction), single merchant, single currency,
// in stock, quantity feasible, total <= stated budget, no duplicate ids
// (structural — combinations are subsets of an already-deduplicated pool).
export function selectBestPlan({ checkedProducts, preferences = [], maxBudget = null, varietyRequested = false }) {
  const { eligible, eligibleCount, overBudgetCount, unavailableCount } = computeCheckedBreakdown(checkedProducts, maxBudget);
  const maxBudgetMinor = maxBudget != null ? toMinorUnits(String(maxBudget)) : null;

  const groups = groupByMerchantAndCurrency(eligible);
  const validCombos = [];
  let evaluatedCount = 0;

  for (const group of groups) {
    const pool = capPool(group);
    const maxSize = Math.min(MAX_COMBINATION_SIZE, pool.length);
    for (let size = MIN_COMBINATION_SIZE; size <= maxSize; size++) {
      for (const products of combinationsOfSize(pool, size)) {
        evaluatedCount += 1;
        const totalMinor = products.reduce((sum, p) => sum + toMinorUnits(p.price), 0);
        if (maxBudgetMinor != null && totalMinor > maxBudgetMinor) continue; // hard gate — never relaxed
        validCombos.push({ products, totalMinor });
      }
    }
  }

  validCombos.sort((a, b) => compareCombinations(a, b, preferences, varietyRequested));

  const ranked = validCombos.slice(0, MAX_RANKED_CANDIDATES).map((combo) => ({
    items: combo.products.map((product) => ({ productId: product.id, quantity: 1 })),
    preferencesCovered: coveredPreferences(combo.products, preferences),
  }));

  return { eligibleCount, overBudgetCount, unavailableCount, evaluatedCount, ranked };
}
