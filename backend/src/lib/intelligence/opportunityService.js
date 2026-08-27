import { prisma } from "../prisma.js";
import { validateProductInput } from "../productValidation.js";
import { proposeMerchandisingAction } from "./merchandisingProvider.js";
import { toMinorUnits, fromMinorUnits } from "../ai/buyer/cart.js";
import { BUDGET_BAND_CEILINGS, hasActionableIntent } from "./demandService.js";

const MAX_CANDIDATE_PRODUCTS = 50;
const MIN_BUNDLE_COMPONENTS = 2;
// Growth Agent — historical-fit simulation bound. Deliberately small: this
// scans real rows synchronously on the detail/generate-draft request path,
// never a background job. 200 is generous for a demo-scale merchant catalog
// and keeps the query trivially fast; if a merchant's real history ever
// exceeds it, `scanBounded` on the result says so honestly rather than
// silently pretending the scan was exhaustive.
const MAX_HISTORICAL_EVENTS_SCANNED = 200;

// Phase 7 — read/lifecycle side of the intelligence layer. Numeric stats
// (event counts, recency, potential value) are ALWAYS computed live from
// DemandEvent here — never cached on the Opportunity row — so they can
// never go stale. Decision 7: money is never part of the priority score.

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const SEVERITY_WEIGHT = {
  OUT_OF_STOCK: 5,
  INSUFFICIENT_STOCK: 5,
  NO_MATCH: 3,
  NO_MORE_OPTIONS: 2,
};

function computeScore({ eventCount, recentEventCount7d, reason }) {
  const frequencyPoints = eventCount * 2;
  const recencyPoints = recentEventCount7d;
  const severityPoints = SEVERITY_WEIGHT[reason] ?? 0;
  return {
    frequencyPoints,
    recencyPoints,
    severityPoints,
    total: frequencyPoints + recencyPoints + severityPoints,
  };
}

// Feature 2 — deterministic 5-way action family, chosen ONLY from
// opportunity.reason (an enum) and, for NO_MATCH, a real catalog-gap fact
// (see getCatalogGap below). Gemini never chooses or influences which
// family applies — it only ever writes wording/draft details AFTER the
// family (and, for CREATE_PRODUCT/CREATE_VARIANT/ADD_OPTION, whether a
// draft is even permitted) has already been decided here.
function determineAction({ reason, catalogGap }) {
  if (reason === "OUT_OF_STOCK") return { type: "RESTOCK_PRODUCT", label: "Restock this product" };
  if (reason === "INSUFFICIENT_STOCK") return { type: "INCREASE_STOCK", label: "Increase stock for this product" };
  if (reason === "NO_MORE_OPTIONS") return { type: "ADD_OPTION", label: "Add another option in this category" };
  // NO_MATCH: CREATE_VARIANT only when a relevant APPROVED product genuinely
  // exists but sits outside this demand cluster's budget band — proven by
  // getCatalogGap's exact, unpaginated price-ascending query, never guessed.
  if (catalogGap?.hasApprovedMatch && catalogGap.gapExists) {
    return { type: "CREATE_VARIANT", label: "Create a lower-priced version" };
  }
  return { type: "CREATE_PRODUCT", label: "Create a new product" };
}

// Draft-eligible action types all funnel through the exact same, unchanged
// generateDraftForOpportunity call — the type only changes wording/context,
// never the underlying mechanism or its hard gates.
export const DRAFT_ELIGIBLE_ACTION_TYPES = ["CREATE_PRODUCT", "CREATE_VARIANT", "ADD_OPTION"];
export const RESTOCK_ACTION_TYPES = ["RESTOCK_PRODUCT", "INCREASE_STOCK"];

// Growth Agent correctness fix — deterministic, evidence-based
// demand-supported price ceiling. Deliberately NOT Math.min (one extreme
// low-budget signal could veto pricing for an entire cluster) and NOT a
// naive median (can interpolate a price no buyer ever actually stated).
// Returns the highest ACTUALLY-OBSERVED maxPrice supported by a strict
// majority (>50%) of known-budget signals — explainable in one sentence:
// "the highest price more than half of real buyers said they'd pay."
// Symmetric against outliers in either direction (one very cheap OR one
// very expensive lone signal can never form a majority once there are 3+
// signals). Candidates are only real observed values — never rounded,
// interpolated, or invented.
function computeDemandSupportedCeiling(events) {
  const knownMaxPrices = events.map((e) => e.maxPrice).filter((v) => v != null).map(Number);
  const totalSignals = events.length;
  const knownBudgetSignals = knownMaxPrices.length;

  if (knownBudgetSignals === 0) {
    // No known-budget evidence at all — never invent a ceiling from thin air.
    return { ceiling: null, knownBudgetSignals: 0, totalSignals, supportedSignals: null, coverage: null, observedMaxPrices: [] };
  }

  const candidates = [...new Set(knownMaxPrices)].sort((a, b) => b - a);
  for (const candidate of candidates) {
    const supportedSignals = knownMaxPrices.filter((v) => v >= candidate).length;
    const coverage = supportedSignals / knownBudgetSignals;
    if (coverage > 0.5) {
      return { ceiling: candidate, knownBudgetSignals, totalSignals, supportedSignals, coverage, observedMaxPrices: knownMaxPrices };
    }
  }
  // Unreachable in practice — the smallest candidate always has 100%
  // coverage, which always satisfies >0.5 — kept only as a type-safe guard.
  const smallest = candidates[candidates.length - 1];
  return {
    ceiling: smallest,
    knownBudgetSignals,
    totalSignals,
    supportedSignals: knownBudgetSignals,
    coverage: 1,
    observedMaxPrices: knownMaxPrices,
  };
}

// Growth Agent — BUNDLE evidence check. DemandEvent's full field set
// (queryText, category, minPrice, maxPrice, budgetBand, requestedQuantity,
// productId, availableQuantity, estimatedValue) contains nothing proving a
// buyer wanted MULTIPLE different items together — that concept
// (groupSize/varietyRequested) exists only in Feature 1's buyer-side
// propose_bundle arguments and is never persisted to DemandEvent. This is a
// real function, not a stub: under the CURRENT schema it always returns
// false, and it is the single place to extend later if a future signal
// ever captures genuine multi-item evidence.
// eslint-disable-next-line no-unused-vars
function hasBundleEvidence(events) {
  return false;
}

// Growth Agent — makes determineAction's decision CAUSAL. Previously its
// output only drove UI text; generateDraftForOpportunity never consulted
// it, which is exactly how a BUNDLE could be generated for an opportunity
// the UI simultaneously labeled a simple "create a new product" case. Every
// action type now maps to a concrete, enforced generation policy.
function buildGenerationPolicy({ actionType, catalogGap, bundleEvidence, demandCeiling }) {
  if (actionType === "CREATE_VARIANT") {
    // "A lower-priced version" is inherently single-item — BUNDLE is never
    // semantically valid here, regardless of bundle evidence.
    return { allowedProposalTypes: ["VARIANT"], priceCeiling: demandCeiling.ceiling };
  }
  // CREATE_PRODUCT / ADD_OPTION: BUNDLE only when real evidence exists.
  return {
    allowedProposalTypes: bundleEvidence ? ["BUNDLE", "VARIANT"] : ["VARIANT"],
    priceCeiling: demandCeiling.ceiling,
  };
}

// Growth Agent correctness fix — pure predicates, factored out so the two
// hard gates in generateDraftForOpportunity are independently unit-testable
// without a live Gemini call. `null` price or `null` ceiling/comparison
// price always means "nothing to check" (no evidence to invent a
// constraint from), never a silent pass disguised as a real check.
function exceedsDemandCeiling(price, priceCeiling) {
  if (price == null || priceCeiling == null) return false;
  return Number(price) > Number(priceCeiling);
}

function isNotLowerPriced(price, cheapestApprovedPrice) {
  if (price == null || cheapestApprovedPrice == null) return false;
  return Number(price) >= Number(cheapestApprovedPrice);
}

// Mirrors the exact same purchasability rule already used on the buyer
// commerce path (planOptimizer.js's isUnavailable, inverted) — kept as an
// independent copy here rather than importing from that module, since
// Feature 1 is locked and this file must not create a dependency on it.
// "Approved" and "available" are deliberately two different facts: a
// product can be APPROVED (merchant reviewed it) while still being
// OUT_OF_STOCK or UNKNOWN (not currently purchasable) — the Growth Feed
// must never collapse these into one checkmark.
function isProductPurchasable(product) {
  if (!product) return false;
  return product.availability === "IN_STOCK" && (product.stockQuantity === null || product.stockQuantity >= 1);
}

// Feature 2 — EXACT catalog-gap evidence. Deliberately NOT built on top of
// commerceService.searchProducts, which is paginated/ordered by recency and
// can never mathematically guarantee it examined every matching row. This
// is a direct, unpaginated Prisma query ordered by price ascending, so the
// single row returned is provably the cheapest matching APPROVED product —
// never an approximation from a truncated sample.
async function getCatalogGap({ merchantId, category, queryText, demandMaxPrice, excludeProductId }) {
  if (!category && !queryText) return null; // no defensible relevance criterion at all

  const where = { merchantId, status: "APPROVED", price: { not: null } };
  // Correctness fix: for an ACTIONED opportunity, the product THIS
  // opportunity itself generated must never count as evidence that a
  // matching product already existed — that's circular (the AI's own
  // output being cited as the reason the AI's output wasn't needed).
  // excludeProductId is only ever the opportunity's own generatedProductId.
  if (excludeProductId) where.id = { not: excludeProductId };
  const isExactCategory = Boolean(category);
  if (isExactCategory) {
    where.category = { equals: category, mode: "insensitive" };
  } else {
    where.OR = [
      { name: { contains: queryText, mode: "insensitive" } },
      { description: { contains: queryText, mode: "insensitive" } },
      { category: { contains: queryText, mode: "insensitive" } },
    ];
  }

  const cheapest = await prisma.product.findFirst({ where, orderBy: { price: "asc" } });
  if (!cheapest) return { hasApprovedMatch: false, isExactCategory };

  return {
    hasApprovedMatch: true,
    isExactCategory,
    cheapestApprovedPrice: cheapest.price.toFixed(2),
    cheapestApprovedProductName: cheapest.name,
    // Hard gate is a real, provable comparison against the demand band's
    // own stated ceiling — never a fabricated threshold.
    gapExists: demandMaxPrice != null && Number(cheapest.price) > Number(demandMaxPrice),
  };
}

// Growth Agent correctness fix — the SAME demand-supported pricing policy
// enforced once at draft-generation time (generateDraftForOpportunity) must
// keep holding for the rest of a product's life: whenever the merchant
// later sets/edits its price (PATCH) and, as the final and only truly
// unbypassable gate, at approval. Re-derives everything live from
// product.originOpportunityId -> Opportunity.groupKey -> DemandEvent rows
// and the current catalog — never a frozen snapshot, never anything Gemini
// claimed. No-ops entirely for MANUAL/CRAWL/FILE_UPLOAD products.
//
// Returns one of three statuses:
//   NOT_APPLICABLE — not an AI_OPPORTUNITY product, no price to check yet,
//                    or the origin is a stock-reason opportunity (which
//                    never carries a demand-supported-price concept at all).
//   UNVERIFIABLE   — the product structurally claims a Feature 2 origin
//                    (originOpportunityId is set) but that Opportunity can
//                    no longer be loaded. Deliberately NOT treated as
//                    "nothing to check" — an AI-generated product must
//                    never become approved/purchasable on a price nobody
//                    can verify against real demand evidence.
//   CHECKED        — a real comparison ran; `errors` lists which rule(s),
//                    if any, the candidate price violates.
export async function validateGeneratedProductPrice({ product, candidatePrice }) {
  if (product.sourceType !== "AI_OPPORTUNITY" || !product.originOpportunityId) {
    return { status: "NOT_APPLICABLE", errors: [] };
  }
  if (candidatePrice == null) {
    // Nothing to check yet — the existing approval-requirements gate
    // already blocks approving a product with no price at all.
    return { status: "NOT_APPLICABLE", errors: [] };
  }

  const opportunity = await prisma.opportunity.findFirst({ where: { id: product.originOpportunityId, merchantId: product.merchantId } });
  if (!opportunity) {
    return { status: "UNVERIFIABLE", errors: [] };
  }
  if (opportunity.reason === "OUT_OF_STOCK" || opportunity.reason === "INSUFFICIENT_STOCK") {
    // Defensive only — these reasons never generate a product in the first
    // place (generateDraftForOpportunity refuses them), so this is already
    // an anomalous state; there is no demand-supported-price concept for a
    // restock/increase-stock action to check against either way.
    return { status: "NOT_APPLICABLE", errors: [] };
  }

  const events = await prisma.demandEvent.findMany({
    where: { merchantId: product.merchantId, groupKey: opportunity.groupKey },
    orderBy: { createdAt: "desc" },
  });
  const demandCeiling = computeDemandSupportedCeiling(events);
  const representative = events[0] ?? null;
  const catalogGap = await getCatalogGap({
    merchantId: product.merchantId,
    category: representative?.category ?? null,
    queryText: representative?.queryText ?? null,
    demandMaxPrice: representative?.maxPrice ? Number(representative.maxPrice) : null,
    excludeProductId: product.id,
  });

  const errors = [];
  if (exceedsDemandCeiling(candidatePrice, demandCeiling.ceiling)) {
    errors.push({
      code: "PRICE_EXCEEDS_DEMAND_CEILING",
      ceiling: demandCeiling.ceiling,
      supportedSignals: demandCeiling.supportedSignals,
      knownBudgetSignals: demandCeiling.knownBudgetSignals,
    });
  }
  // Only enforced when live catalog evidence genuinely establishes the
  // undercut case right now — if that evidence has since disappeared (the
  // expensive product was deleted/rejected/repriced), this rule honestly
  // stops applying rather than enforcing a stale narrative.
  if (
    catalogGap?.hasApprovedMatch &&
    catalogGap.gapExists &&
    isNotLowerPriced(candidatePrice, catalogGap.cheapestApprovedPrice)
  ) {
    errors.push({
      code: "PRICE_NOT_LOWER_THAN_CATALOG_MATCH",
      cheapestApprovedPrice: catalogGap.cheapestApprovedPrice,
      cheapestApprovedProductName: catalogGap.cheapestApprovedProductName,
    });
  }

  return { status: "CHECKED", errors };
}

// Careful, grammar-safe phrasing — avoids singular/plural guessing on raw
// merchant-entered category text (e.g. "cakes", "Coffee & Tea") by never
// inflecting it. Only ever built from getCatalogGap's own proven fields.
function buildCatalogGapExplanation({ catalogGap, category, queryText }) {
  if (!catalogGap?.hasApprovedMatch) return null;
  const priceText = `₹${Number(catalogGap.cheapestApprovedPrice).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (catalogGap.isExactCategory && category) {
    return `Your cheapest approved product in the "${category}" category is ${priceText}.`;
  }
  return `The lowest-priced approved product found for "${queryText || category}" is ${priceText}.`;
}

// Feature 2 — demand concentration across sibling price bands for the SAME
// underlying intent. Budget band is already baked into groupKey itself
// (see demandService.computeGroupKey: "...|intent|max:<band>"), so sibling
// clusters are just other DemandEvent rows whose groupKey shares everything
// up to and including "|max:" — a single indexed groupBy proves the real
// distribution, never an invented percentage. Stock-reason groupKeys
// ("merchantId|reason|productId") structurally never contain "|max:", so
// they can never accidentally match this prefix.
function groupKeyIntentPrefix(groupKey) {
  const marker = "|max:";
  const idx = groupKey.indexOf(marker);
  return idx === -1 ? null : groupKey.slice(0, idx + marker.length);
}

function parseBandFromGroupKeySuffix(groupKey, prefix) {
  return groupKey.slice(prefix.length).split("|")[0];
}

async function getDemandConcentration({ merchantId, reason, groupKey }) {
  const prefix = groupKeyIntentPrefix(groupKey);
  if (!prefix) return null;

  const siblings = await prisma.demandEvent.groupBy({
    by: ["groupKey"],
    where: { merchantId, reason, groupKey: { startsWith: prefix } },
    _count: { _all: true },
  });
  const total = siblings.reduce((sum, s) => sum + s._count._all, 0);
  if (total === 0) return null;

  return siblings
    .map((s) => ({
      band: parseBandFromGroupKeySuffix(s.groupKey, prefix),
      count: s._count._all,
      sharePercent: Math.round((s._count._all / total) * 100),
    }))
    .sort((a, b) => b.count - a.count);
}

// Display-only conversion of a groupKey's budget band (e.g. "<=100") into a
// short everyday phrase. Pure text formatting — never used for any
// calculation, and never changes what band a groupKey belongs to.
function humanizeBudgetBand(budgetBand) {
  if (!budgetBand || budgetBand === "none") return "";
  if (budgetBand.startsWith("<=")) return ` under ₹${Number(budgetBand.slice(2)).toLocaleString("en-IN")}`;
  if (budgetBand.startsWith(">")) return ` over ₹${Number(budgetBand.slice(1)).toLocaleString("en-IN")}`;
  return "";
}

// Growth Agent — same band string, rendered as a range ("₹101–₹250") rather
// than a ceiling-only phrase, for the Growth Brief's "budget pattern" line.
// Pure text formatting over the same BUDGET_BAND_CEILINGS demandService.js
// already uses to compute the band in the first place — never a new
// bucketing scheme.
function humanizeBudgetRange(band) {
  if (!band || band === "none") return null;
  if (band.startsWith(">")) return `over ₹${Number(band.slice(1)).toLocaleString("en-IN")}`;
  const ceiling = Number(band.slice(2));
  const idx = BUDGET_BAND_CEILINGS.indexOf(ceiling);
  const floor = idx > 0 ? BUDGET_BAND_CEILINGS[idx - 1] + 1 : null;
  return floor != null
    ? `in the ₹${floor.toLocaleString("en-IN")}-₹${ceiling.toLocaleString("en-IN")} range`
    : `under ₹${ceiling.toLocaleString("en-IN")}`;
}

// Growth Agent — Growth Brief's one-line "where the money is" summary, built
// strictly from getDemandConcentration's own already-proven counts/shares.
function buildBudgetPatternText(demandConcentration) {
  if (!demandConcentration || demandConcentration.length === 0) return null;
  const top = demandConcentration[0];
  const phrase = humanizeBudgetRange(top.band);
  if (!phrase) return null;
  return demandConcentration.length === 1 ? `All signals are ${phrase}.` : `Most signals (${top.sharePercent}%) are ${phrase}.`;
}

// Growth Agent — deterministic "why SmartCart is acting" sentence. Templates
// only; every branch is selected from real reason/catalogGap facts already
// computed elsewhere in this file, never from Gemini.
function buildWhyActingText({ reason, catalogGap }) {
  switch (reason) {
    case "NO_MATCH":
      if (!catalogGap || !catalogGap.hasApprovedMatch) {
        return "Buyers are asking for this and your catalog has nothing approved that matches.";
      }
      if (catalogGap.gapExists) {
        return "Buyers are repeatedly asking below your current catalog price.";
      }
      return "A matching approved product already exists within budget - check whether it's already solving this before creating another.";
    case "NO_MORE_OPTIONS":
      return "Buyers saw your existing options and asked for more variety in this category.";
    case "OUT_OF_STOCK":
      return "Buyers tried to buy this and it wasn't in stock.";
    case "INSUFFICIENT_STOCK":
      return "Buyers wanted more of this than you had in stock.";
    default:
      return "Buyers showed repeated interest in this.";
  }
}

// Growth Agent — Layer 1 (SMARTCART GROWTH BRIEF). Every field is assembled
// from facts already computed elsewhere in this file (label, stats,
// demandConcentration, catalogGap, suggestedAction) — no new queries, no
// Gemini involvement. Computed for every reason; budgetPattern/currentGap
// are honestly null for stock reasons (no catalog-gap concept there).
function buildGrowthBrief({ reason, label, eventCount, recentEventCount7d, demandConcentration, catalogGap, suggestedAction }) {
  return {
    whatBuyersWant: label || "this",
    demand: { total: eventCount, recent7d: recentEventCount7d },
    budgetPattern: buildBudgetPatternText(demandConcentration),
    currentGap: catalogGap?.explanation ?? null,
    whyActing: buildWhyActingText({ reason, catalogGap }),
    recommendedAction: suggestedAction?.label ?? null,
  };
}

// Growth Agent — Layer 2/4 counterfactual historical-demand pool. Reuses the
// EXACT same relevance predicate as getCatalogGap (category equals-
// insensitive, or name/description/category contains-insensitive) against
// DemandEvent instead of Product — not a new fuzzy matcher. Scoped to one
// merchant and the two draft-eligible reason families only, which
// structurally excludes OUT_OF_STOCK/INSUFFICIENT_STOCK demand from ever
// entering a new-product simulation. Bounded by MAX_HISTORICAL_EVENTS_SCANNED,
// most-recent-first, so a truncated scan is always the most relevant one.
async function getHistoricalDemandPool({ merchantId, category, queryText }) {
  if (!category && !queryText) return []; // no defensible relevance criterion at all

  const where = { merchantId, reason: { in: ["NO_MATCH", "NO_MORE_OPTIONS"] } };
  if (category) {
    where.category = { equals: category, mode: "insensitive" };
  } else {
    where.OR = [
      { queryText: { contains: queryText, mode: "insensitive" } },
      { category: { contains: queryText, mode: "insensitive" } },
    ];
  }

  return prisma.demandEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: MAX_HISTORICAL_EVENTS_SCANNED,
  });
}

// Growth Agent — the actual "would have fit" judgment over an already-fetched
// pool. Deterministic price comparison only (candidatePrice <= event.maxPrice
// when it exists, candidatePrice >= event.minPrice when it exists) — category/
// text relevance was already proven by the pool's own WHERE clause. This is
// historical demand EVIDENCE, never a sales prediction: addressableObservedValue
// is the sum of what buyers said they'd spend, not a revenue forecast.
function matchHistoricalFit(events, candidatePrice) {
  const totalHistoricalSignals = events.length;
  const matched = events.filter((event) => {
    if (event.maxPrice != null && Number(candidatePrice) > Number(event.maxPrice)) return false;
    if (event.minPrice != null && Number(candidatePrice) < Number(event.minPrice)) return false;
    return true;
  });

  let observedMinor = 0;
  for (const event of matched) {
    if (event.maxPrice != null) observedMinor += toMinorUnits(Number(event.maxPrice).toFixed(2));
  }

  return {
    totalHistoricalSignals,
    addressableSignals: matched.length,
    addressableObservedValue: observedMinor > 0 ? fromMinorUnits(observedMinor) : null,
    matchedEventIds: matched.map((event) => event.id),
    scanBounded: totalHistoricalSignals === MAX_HISTORICAL_EVENTS_SCANNED,
  };
}

// Growth Agent — public entry point. Returns null ONLY when no test is even
// possible (no candidate price yet, e.g. an unpriced VARIANT draft) — an
// empty historical pool is still a real, honest answer ("0 of 0") and is
// returned as such, never collapsed into the same null as "not applicable".
async function simulateHistoricalFit({ merchantId, category, queryText, candidatePrice }) {
  if (candidatePrice == null) return null;
  const events = await getHistoricalDemandPool({ merchantId, category, queryText });
  return matchHistoricalFit(events, candidatePrice);
}

// Growth Agent — Layer 3 (ACTION READINESS). Deterministic evidence flags
// only — never a confidence score or percentage. Flags are filtered by
// reason family so a stock-reason opportunity never shows a meaningless
// "catalog gap" warning.
function buildActionReadiness({ reason, recentEventCount7d, budgetBand, catalogGap, hasHistoricalSignals }) {
  const flags = [
    { key: "thresholdReached", ok: true, label: "Repeated demand detected" },
    {
      key: "hasRecentDemand",
      ok: recentEventCount7d > 0,
      label: recentEventCount7d > 0 ? "Demand happened recently" : "No recent demand in the last 7 days",
    },
  ];

  if (reason === "NO_MATCH" || reason === "NO_MORE_OPTIONS") {
    const hasBudgetEvidence = Boolean(budgetBand) && budgetBand !== "none";
    flags.push({
      key: "hasBudgetEvidence",
      ok: hasBudgetEvidence,
      label: hasBudgetEvidence ? "Budget pattern is clear" : "No clear budget pattern",
    });
    flags.push({
      key: "hasCatalogGapEvidence",
      ok: catalogGap !== null,
      label: catalogGap !== null ? "Catalog gap confirmed" : "Catalog gap could not be confirmed",
    });
    if (catalogGap) {
      flags.push({
        key: "hasExactCategoryEvidence",
        ok: catalogGap.isExactCategory,
        label: catalogGap.isExactCategory
          ? "Product match is based on an exact category"
          : "Product match is based on search text, not an exact category",
      });
    }
    flags.push({
      key: "historicalFitAvailable",
      ok: hasHistoricalSignals,
      label: hasHistoricalSignals ? "Historical demand pattern available for testing" : "Not enough historical signals to test this idea",
    });
  }

  return { flags };
}

// Growth Agent — Layer 6 (outcome interpretation). Every line is an
// independent, deterministic check over real lifecycle state — several can
// fire at once (e.g. paid orders AND new signals since action). Only ever
// called for ACTIONED/DISMISSED opportunities; nothing to interpret yet for
// OPEN ones.
function buildOutcomeInterpretation({ status, generatedProduct, attribution, signalsSinceAction }) {
  const lines = [];

  if (status === "DISMISSED") {
    lines.push("The merchant dismissed this opportunity. SmartCart will not count it as a launched solution.");
    return lines;
  }
  if (generatedProduct && !generatedProduct.deleted && generatedProduct.status === "REJECTED") {
    lines.push("The merchant rejected the AI-generated product. SmartCart will not count it as a launched solution.");
    return lines;
  }

  if (attribution?.orderCount > 0) {
    lines.push(`This action has already produced ${attribution.orderCount} paid order${attribution.orderCount === 1 ? "" : "s"}.`);
  } else if (generatedProduct && !generatedProduct.deleted && generatedProduct.status === "APPROVED") {
    lines.push("This product is live, but no paid order has been attributed yet.");
  }
  if (signalsSinceAction > 0) {
    lines.push(`${signalsSinceAction} more matching demand signal${signalsSinceAction === 1 ? "" : "s"} appeared after this action.`);
  }

  return lines;
}

// Growth Agent — ADD_OPTION context: how many approved options already exist
// in this category, so "buyers want more choices" is backed by a real count.
// Same self-reference fix as getCatalogGap: an ACTIONED opportunity's own
// generated option must never inflate the "you already have N options" count.
async function getExistingOptionCount({ merchantId, category, excludeProductId }) {
  if (!category) return null;
  const where = { merchantId, category: { equals: category, mode: "insensitive" }, status: "APPROVED" };
  if (excludeProductId) where.id = { not: excludeProductId };
  return prisma.product.count({ where });
}

// Growth Agent — INCREASE_STOCK/OUT_OF_STOCK context: the plain arithmetic
// gap between what was requested and what was available on the most recent
// signal. Never shown as a claim about current stock — only about that one
// past request.
function buildStockGapFact(representative) {
  if (representative?.requestedQuantity == null || representative?.availableQuantity == null) return null;
  const gap = representative.requestedQuantity - representative.availableQuantity;
  return gap > 0 ? gap : null;
}

// Deterministic, backend-authored explanation — Gemini never sees or
// generates this. Every number in it comes straight from the same trusted
// aggregates already computed for the score/value fields. Wording kept in
// short, everyday English (Phase 8 UX pass) — the underlying facts (count,
// band, reason) are unchanged.
function buildWhyExplanation({ reason, label, budgetBand, eventCount, status, demandCeiling }) {
  const people = eventCount === 1 ? "person" : "people";
  const budgetPart = humanizeBudgetBand(budgetBand);
  // Prefer the real, evidence-derived ceiling (an exact ₹ figure backed by
  // actual maxPrice signals) over the coarser budgetBand bucket phrase
  // whenever it's available — the band exists only for deterministic
  // grouping and can be wider than what buyers actually asked for (e.g. a
  // ₹200 signal still falls in the "<=250" bucket). Falls back to the band
  // phrase when there's no ceiling evidence at all (e.g. stock reasons, or
  // a cluster with no known-budget signals).
  const pricePart = demandCeiling?.ceiling != null ? ` under ₹${Number(demandCeiling.ceiling).toLocaleString("en-IN")}` : budgetPart;

  // No recoverable product intent — never invent a subject, and never the
  // article that goes with an invented one ("searched for a this"). After
  // the eligibility fix (writeOne in demandService.js), a brand-new
  // opportunity should rarely reach here with no label — this remains as
  // an honest fallback for edge cases and for opportunities that predate
  // that invariant.
  if (!label && (reason === "NO_MATCH" || reason === "NO_MORE_OPTIONS")) {
    const verb = reason === "NO_MATCH" ? "did not find a suitable match" : "found nothing new to show";
    return `${eventCount} search${eventCount === 1 ? "" : "es"}${pricePart} ${verb}.`;
  }

  const subject = label || "this";
  switch (reason) {
    case "NO_MATCH":
      // A NO_MATCH DemandEvent only proves that one specific search (with
      // its own filters) found nothing — it does NOT prove "your store did
      // not have one" as a general historical fact about the whole catalog.
      // For ACTIONED, the original "so AI suggested a new product" tail is
      // also dropped here since the SmartCart Action section below already
      // states that fact — no need to repeat it under weaker evidence.
      if (status === "ACTIONED") {
        return `${eventCount} ${people} searched for a ${subject}${pricePart}, but SmartCart couldn't find a suitable match.`;
      }
      return `${eventCount} ${people} wanted a ${subject}${pricePart}. Your store did not have one, so AI suggested a new product.`;
    case "NO_MORE_OPTIONS":
      return `${eventCount} ${people} wanted more choices for ${subject}${pricePart} after seeing what you already sell.`;
    case "OUT_OF_STOCK":
      return `${eventCount} ${people} tried to buy ${subject}, but it was out of stock.`;
    case "INSUFFICIENT_STOCK":
      return `${eventCount} ${people} wanted more of ${subject} than you had in stock.`;
    default:
      return `${eventCount} ${people} showed interest in this.`;
  }
}

// One pair of groupBy queries for the WHOLE merchant, not one query per
// opportunity — keeps the list endpoint at O(1) aggregation queries
// regardless of how many opportunities exist.
async function loadStatsByGroupKey(merchantId) {
  const sevenDaysAgo = new Date(Date.now() - RECENT_WINDOW_MS);

  const [allTime, recent] = await Promise.all([
    prisma.demandEvent.groupBy({
      by: ["groupKey"],
      where: { merchantId },
      _count: { _all: true },
      _sum: { estimatedValue: true },
    }),
    prisma.demandEvent.groupBy({
      by: ["groupKey"],
      where: { merchantId, createdAt: { gte: sevenDaysAgo } },
      _count: { _all: true },
    }),
  ]);

  const recentByKey = new Map(recent.map((r) => [r.groupKey, r._count._all]));
  const stats = new Map();
  for (const row of allTime) {
    stats.set(row.groupKey, {
      eventCount: row._count._all,
      recentEventCount7d: recentByKey.get(row.groupKey) || 0,
      potentialDemandValue: row._sum.estimatedValue ? row._sum.estimatedValue.toFixed(2) : null,
    });
  }
  return stats;
}

// One representative (most recent) DemandEvent per groupKey, for a
// human-readable card label — a single query via Prisma's `distinct`,
// never one query per opportunity.
async function loadRepresentativeByGroupKey(merchantId, groupKeys) {
  if (groupKeys.length === 0) return new Map();
  const rows = await prisma.demandEvent.findMany({
    where: { merchantId, groupKey: { in: groupKeys } },
    orderBy: { createdAt: "desc" },
    distinct: ["groupKey"],
  });
  return new Map(rows.map((r) => [r.groupKey, r]));
}

// `fallbackScope` (optional) lets the caller recover a real label when the
// single most-recent event lacks both category and queryText but an EARLIER
// event in the same demand cluster genuinely has one — never invents text,
// just looks further back in the same group's own real history. Omitted by
// callers that don't need it (e.g. generateDraftForOpportunity's Gemini
// context, where the generic fallback is harmless).
async function labelFor(reason, representative, fallbackScope) {
  if (reason === "OUT_OF_STOCK" || reason === "INSUFFICIENT_STOCK") {
    if (!representative?.productId) return null;
    const product = await prisma.product.findUnique({ where: { id: representative.productId }, select: { name: true } });
    return product ? product.name : null;
  }
  if (!representative) return null;
  if (representative.category || representative.queryText) {
    return representative.category || representative.queryText;
  }
  // Check any already-loaded events first (free — no extra query) before
  // reaching for the DB fallback below.
  for (const event of fallbackScope?.additionalEvents ?? []) {
    if (event.category || event.queryText) return event.category || event.queryText;
  }
  if (fallbackScope?.merchantId && fallbackScope?.groupKey) {
    const olderEventWithText = await prisma.demandEvent.findFirst({
      where: {
        merchantId: fallbackScope.merchantId,
        groupKey: fallbackScope.groupKey,
        OR: [{ category: { not: null } }, { queryText: { not: null } }],
      },
      orderBy: { createdAt: "desc" },
    });
    if (olderEventWithText) return olderEventWithText.category || olderEventWithText.queryText;
  }
  return null;
}

// `representative` is the most recent DemandEvent for this group (or null)
// — used only to surface human-readable intent context (budget band,
// requested quantity/stock gap); every COUNT/SUM number still comes from
// `stats`, never from this single row.
function toOpportunityListDTO(opportunity, stats, label, representative, catalogGap = null, demandCeiling = null) {
  const scoreBreakdown = computeScore({ ...stats, reason: opportunity.reason });
  const budgetBand = representative?.budgetBand ?? null;

  let intentSummary = null;
  if (opportunity.reason === "NO_MATCH" || opportunity.reason === "NO_MORE_OPTIONS") {
    intentSummary = budgetBand && budgetBand !== "none" ? `Budget: ${budgetBand}` : null;
  } else if (representative?.requestedQuantity != null) {
    intentSummary =
      representative.availableQuantity != null
        ? `Most recent request: ${representative.requestedQuantity} (${representative.availableQuantity} available)`
        : `Most recent request: ${representative.requestedQuantity}`;
  }

  const signalsBeforeAction = opportunity.signalCountAtAction ?? null;
  const signalsSinceAction = signalsBeforeAction != null ? Math.max(stats.eventCount - signalsBeforeAction, 0) : null;

  return {
    id: opportunity.id,
    label,
    budgetBand,
    intentSummary,
    reason: opportunity.reason,
    status: opportunity.status,
    eventCount: stats.eventCount,
    recentEventCount7d: stats.recentEventCount7d,
    potentialDemandValue: stats.potentialDemandValue,
    score: scoreBreakdown.total,
    scoreBreakdown,
    whyExplanation: buildWhyExplanation({
      reason: opportunity.reason,
      label,
      budgetBand,
      eventCount: stats.eventCount,
      status: opportunity.status,
      demandCeiling,
    }),
    // The list endpoint never computes catalogGap (kept cheap — see
    // getOpportunityForMerchant for the fully accurate, detail-only
    // version); NO_MATCH defaults to CREATE_PRODUCT here and is refined to
    // CREATE_VARIANT once the detail page's exact catalog-gap query runs.
    suggestedAction: determineAction({ reason: opportunity.reason, catalogGap }),
    generatedProductId: opportunity.generatedProductId,
    signalsBeforeAction,
    signalsSinceAction,
    firstSeenAt: opportunity.firstSeenAt,
    lastSeenAt: opportunity.lastSeenAt,
  };
}

function toDemandEventExampleDTO(event) {
  return {
    queryText: event.queryText,
    category: event.category,
    budgetBand: event.budgetBand,
    minPrice: event.minPrice ? event.minPrice.toFixed(2) : null,
    maxPrice: event.maxPrice ? event.maxPrice.toFixed(2) : null,
    requestedQuantity: event.requestedQuantity,
    availableQuantity: event.availableQuantity,
    createdAt: event.createdAt,
  };
}

export async function listOpportunitiesForMerchant({ merchantId, status }) {
  const opportunities = await prisma.opportunity.findMany({
    where: { merchantId, ...(status ? { status } : {}) },
    orderBy: { lastSeenAt: "desc" },
  });
  if (opportunities.length === 0) return [];

  const [stats, representatives] = await Promise.all([
    loadStatsByGroupKey(merchantId),
    loadRepresentativeByGroupKey(merchantId, opportunities.map((o) => o.groupKey)),
  ]);

  const dtos = await Promise.all(
    opportunities.map(async (o) => {
      const representative = representatives.get(o.groupKey);
      const label = await labelFor(o.reason, representative, { merchantId, groupKey: o.groupKey });
      return toOpportunityListDTO(
        o,
        stats.get(o.groupKey) || { eventCount: 0, recentEventCount7d: 0, potentialDemandValue: null },
        label,
        representative
      );
    })
  );
  return dtos.sort((a, b) => b.score - a.score);
}

export async function getOpportunityForMerchant({ merchantId, opportunityId }) {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: opportunityId, merchantId } });
  if (!opportunity) return null;

  const stats = await loadStatsByGroupKey(merchantId);
  const opportunityStats = stats.get(opportunity.groupKey) || { eventCount: 0, recentEventCount7d: 0, potentialDemandValue: null };

  const recentEvents = await prisma.demandEvent.findMany({
    where: { merchantId, groupKey: opportunity.groupKey },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const representative = recentEvents[0];
  const label = await labelFor(opportunity.reason, representative, {
    merchantId,
    groupKey: opportunity.groupKey,
    additionalEvents: recentEvents.slice(1),
  });

  const isStockReason = opportunity.reason === "OUT_OF_STOCK" || opportunity.reason === "INSUFFICIENT_STOCK";
  const isCatalogGapReason = opportunity.reason === "NO_MATCH" || opportunity.reason === "NO_MORE_OPTIONS";

  // Display-only: derived from the up-to-5 already-fetched recentEvents,
  // not a fresh query. Used for the missing-label fallback sentence and
  // exposed on the DTO for transparency — the actual generation-time
  // enforcement (generateDraftForOpportunity) always recomputes this over
  // every DemandEvent in the groupKey, never this bounded approximation.
  const demandCeiling = isCatalogGapReason ? computeDemandSupportedCeiling(recentEvents) : null;

  // Detail-only, exact evidence — deliberately NOT computed on the list
  // endpoint (see toOpportunityListDTO) since it costs an extra query per
  // opportunity. Stock-reason opportunities have no "catalog gap" concept
  // (the product already exists), so both stay null there.
  let catalogGap = null;
  let demandConcentration = null;
  let historicalPool = [];
  if (isCatalogGapReason) {
    [catalogGap, demandConcentration, historicalPool] = await Promise.all([
      getCatalogGap({
        merchantId,
        category: representative?.category ?? null,
        queryText: representative?.queryText ?? null,
        demandMaxPrice: representative?.maxPrice ? Number(representative.maxPrice) : null,
        excludeProductId: opportunity.generatedProductId ?? undefined,
      }),
      getDemandConcentration({ merchantId, reason: opportunity.reason, groupKey: opportunity.groupKey }),
      getHistoricalDemandPool({
        merchantId,
        category: representative?.category ?? null,
        queryText: representative?.queryText ?? null,
      }),
    ]);
  }

  const listDTO = toOpportunityListDTO(opportunity, opportunityStats, label, representative, catalogGap, demandCeiling);

  let generatedProduct = null;
  let relatedProduct = null;
  let attribution = null;

  if (opportunity.generatedProductId) {
    // Deliberately re-reads live product status — a rejected or deleted
    // draft must be shown honestly, never as a stale "actioned" success.
    const product = await prisma.product.findUnique({ where: { id: opportunity.generatedProductId } });
    generatedProduct = product
      ? {
          id: product.id,
          name: product.name,
          status: product.status,
          price: product.price ? product.price.toFixed(2) : null,
          // Correction 2: exposed separately from `status` so the UI can
          // never collapse "merchant approved" and "product available" into
          // one fact — a product can be APPROVED and still OUT_OF_STOCK.
          availability: product.availability,
          stockQuantity: product.stockQuantity,
        }
      : { id: opportunity.generatedProductId, deleted: true };
    // Closed-loop attribution (Decision 12): only ever computed from real
    // PAID OrderItems referencing this exact generated product id — never
    // claimed for a Conversion Recovery alternative.
    attribution = await getAttributionForProduct(opportunity.generatedProductId);
  } else if (isStockReason && representative?.productId) {
    // Stock-reason opportunities never generate a new product — every event
    // in this group shares the SAME productId by groupKey construction
    // ("merchantId|reason|productId"), so this is the one real product the
    // demand was about, re-read live for the same honesty reason as above.
    const product = await prisma.product.findUnique({ where: { id: representative.productId } });
    relatedProduct = product
      ? {
          id: product.id,
          name: product.name,
          status: product.status,
          price: product.price ? product.price.toFixed(2) : null,
          availability: product.availability,
          stockQuantity: product.stockQuantity,
        }
      : { id: representative.productId, deleted: true };
    attribution = await getAttributionForProduct(representative.productId);
  }

  // Explanation attached once here so both growthBrief and the final
  // catalogGap field below read the identical, fully-formed object — the
  // raw catalogGap (pre-explanation) must never leak into either.
  const catalogGapWithExplanation = catalogGap
    ? {
        ...catalogGap,
        explanation: buildCatalogGapExplanation({
          catalogGap,
          category: representative?.category ?? null,
          queryText: representative?.queryText ?? null,
        }),
      }
    : null;

  // Growth Agent — additive layers. None of these change any field already
  // returned above; they're new, independently-computed facts alongside them.
  const growthBrief = buildGrowthBrief({
    reason: opportunity.reason,
    label,
    eventCount: opportunityStats.eventCount,
    recentEventCount7d: opportunityStats.recentEventCount7d,
    demandConcentration,
    catalogGap: catalogGapWithExplanation,
    suggestedAction: listDTO.suggestedAction,
  });

  const actionReadiness = buildActionReadiness({
    reason: opportunity.reason,
    recentEventCount7d: opportunityStats.recentEventCount7d,
    budgetBand: representative?.budgetBand ?? null,
    catalogGap,
    hasHistoricalSignals: historicalPool.length > 0,
  });

  // Frozen at draft-generation time (see generateDraftForOpportunity) —
  // never recomputed here, so it can never be inflated/deflated by demand
  // that arrived after the proposal was made. Null whenever no draft has
  // been generated yet, or the draft's price was null at creation time.
  const historicalFitAtProposal = opportunity.historicalFitComputedAt
    ? {
        total: opportunity.historicalFitTotalAtProposal,
        addressable: opportunity.historicalFitAddressableAtProposal,
        observedValue: opportunity.historicalFitObservedValueAtProposal
          ? opportunity.historicalFitObservedValueAtProposal.toFixed(2)
          : null,
        computedAt: opportunity.historicalFitComputedAt,
      }
    : null;

  const outcomeInterpretation =
    opportunity.status === "ACTIONED" || opportunity.status === "DISMISSED"
      ? buildOutcomeInterpretation({
          status: opportunity.status,
          generatedProduct,
          attribution,
          signalsSinceAction: listDTO.signalsSinceAction,
        })
      : [];

  const existingOptionCount =
    opportunity.reason === "NO_MORE_OPTIONS"
      ? await getExistingOptionCount({
          merchantId,
          category: representative?.category ?? null,
          excludeProductId: opportunity.generatedProductId ?? undefined,
        })
      : null;

  const stockGap = isStockReason ? buildStockGapFact(representative) : null;

  return {
    ...listDTO,
    recentExamples: recentEvents.map(toDemandEventExampleDTO),
    generatedProduct,
    relatedProduct,
    attribution,
    catalogGap: catalogGapWithExplanation,
    demandConcentration,
    demandSupportedCeiling: demandCeiling,
    growthBrief,
    actionReadiness,
    historicalFitAtProposal,
    outcomeInterpretation,
    existingOptionCount,
    stockGap,
  };
}

export async function dismissOpportunity({ merchantId, opportunityId }) {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: opportunityId, merchantId } });
  if (!opportunity) return { error: "OPPORTUNITY_NOT_FOUND" };
  if (opportunity.status !== "OPEN") return { error: "OPPORTUNITY_NOT_OPEN" };

  await prisma.opportunity.update({
    where: { id: opportunity.id },
    data: { status: "DISMISSED", dismissedAt: new Date() },
  });
  return { opportunity: await getOpportunityForMerchant({ merchantId, opportunityId }) };
}

// Phase 7 Decision 5/6 — Gemini's proposal never carries a price, and its
// componentProductIds are treated as fully untrusted until independently
// re-fetched and re-checked here. A generated draft ALWAYS lands as
// PENDING_REVIEW with stockQuantity null, using the exact same
// validateProductInput() gate as manual/crawl/upload creation.
export async function generateDraftForOpportunity({ merchantId, opportunityId }) {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: opportunityId, merchantId } });
  if (!opportunity) return { error: "OPPORTUNITY_NOT_FOUND" };
  if (opportunity.reason === "OUT_OF_STOCK" || opportunity.reason === "INSUFFICIENT_STOCK") {
    // Decision 10: stock-reason opportunities never generate a draft — the
    // action is to view/restock the existing product, through the existing
    // Catalog edit flow.
    return { error: "OPPORTUNITY_NOT_ACTIONABLE" };
  }
  if (opportunity.status !== "OPEN") return { error: "OPPORTUNITY_NOT_OPEN" };

  const [stats, events, candidateProducts] = await Promise.all([
    loadStatsByGroupKey(merchantId),
    // Every DemandEvent in this groupKey — not just the latest — so the
    // demand-supported ceiling reflects the whole cluster, never "whichever
    // signal happened to arrive last."
    prisma.demandEvent.findMany({ where: { merchantId, groupKey: opportunity.groupKey }, orderBy: { createdAt: "desc" } }),
    prisma.product.findMany({ where: { merchantId, status: "APPROVED" }, take: MAX_CANDIDATE_PRODUCTS }),
  ]);
  const representative = events[0] ?? null;

  // Defense-in-depth: materialization already requires actionable intent
  // for NEW opportunities (see demandService.js's writeOne), but an
  // already-existing opportunity — including one that predates this
  // invariant — must never be actioned into a fabricated product either.
  if (
    (opportunity.reason === "NO_MATCH" || opportunity.reason === "NO_MORE_OPTIONS") &&
    !hasActionableIntent(representative?.category ?? null, representative?.queryText ?? null)
  ) {
    return { error: "INSUFFICIENT_PRODUCT_INTENT" };
  }

  if (candidateProducts.length === 0) {
    return { error: "MERCHANDISING_PROPOSAL_INVALID" };
  }

  const opportunityStats = stats.get(opportunity.groupKey) || { eventCount: 0 };
  const label = await labelFor(opportunity.reason, representative);
  const catalogGap = await getCatalogGap({
    merchantId,
    category: representative?.category ?? null,
    queryText: representative?.queryText ?? null,
    demandMaxPrice: representative?.maxPrice ? Number(representative.maxPrice) : null,
  });

  // Growth Agent correctness fix — determineAction's decision now
  // CAUSALLY constrains generation instead of only driving UI text, and
  // the price ceiling comes from real observed demand, never Gemini.
  const demandCeiling = computeDemandSupportedCeiling(events);
  const bundleEvidence = hasBundleEvidence(events);
  const actionType = determineAction({ reason: opportunity.reason, catalogGap }).type;
  const policy = buildGenerationPolicy({ actionType, catalogGap, bundleEvidence, demandCeiling });

  const result = await proposeMerchandisingAction({
    opportunitySummary: {
      reason: opportunity.reason,
      label,
      eventCount: opportunityStats.eventCount,
      catalogGap,
      demandCeiling,
      allowedProposalTypes: policy.allowedProposalTypes,
    },
    candidateProducts: candidateProducts.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      currency: p.currency,
      price: p.price ? p.price.toFixed(2) : null,
    })),
    allowedProposalTypes: policy.allowedProposalTypes,
  });
  if (result.error) return { error: "MERCHANDISING_PROPOSAL_INVALID" };

  const proposal = result.proposal;
  if (
    !proposal ||
    (proposal.type !== "BUNDLE" && proposal.type !== "VARIANT") ||
    typeof proposal.name !== "string" ||
    proposal.name.trim() === "" ||
    typeof proposal.description !== "string" ||
    !Array.isArray(proposal.componentProductIds)
  ) {
    return { error: "MERCHANDISING_PROPOSAL_INVALID" };
  }

  // Defense-in-depth: the response schema already constrained this (see
  // merchandisingProvider.js), but Gemini's own claim about its type is
  // never trusted as the only line of defense.
  if (!policy.allowedProposalTypes.includes(proposal.type)) {
    return { error: "MERCHANDISING_PROPOSAL_INVALID" };
  }

  // Re-fetch and independently re-verify EVERY claimed component — must
  // exist, be APPROVED, belong to THIS merchant, and have a real price.
  // Gemini's own claim about any of this is never trusted.
  //
  // Deduplicated FIRST, before any validation/summing — [A, A] must be
  // rejected as a degenerate one-component bundle, never treated as two
  // real components (which would double-count A's price in the sum).
  const uniqueComponentIds = [...new Set(proposal.componentProductIds)];
  const candidateById = new Map(candidateProducts.map((p) => [p.id, p]));
  const componentProducts = [];
  for (const id of uniqueComponentIds) {
    const product = candidateById.get(id);
    if (!product || product.merchantId !== merchantId || product.status !== "APPROVED" || product.price === null) {
      return { error: "MERCHANDISING_PROPOSAL_INVALID" };
    }
    componentProducts.push(product);
  }

  let price = null;
  let currency = candidateProducts[0]?.currency || null;
  let description = proposal.description.slice(0, 5000);

  if (proposal.type === "BUNDLE") {
    if (componentProducts.length < MIN_BUNDLE_COMPONENTS) {
      return { error: "MERCHANDISING_PROPOSAL_INVALID" };
    }
    const currencies = new Set(componentProducts.map((p) => p.currency));
    if (currencies.size !== 1) {
      // Cross-currency bundle has no defensible single sum — reject rather
      // than guess.
      return { error: "MERCHANDISING_PROPOSAL_INVALID" };
    }
    currency = componentProducts[0].currency;
    // Decision 5: suggestedPrice = SUM(current trusted component prices),
    // exact minor-unit arithmetic — Gemini never supplies this number.
    const totalMinor = componentProducts.reduce((sum, p) => sum + toMinorUnits(p.price.toFixed(2)), 0);
    price = fromMinorUnits(totalMinor);
    description = `${description}\n\nBundles: ${componentProducts
      .map((p) => `${p.name} (${p.currency} ${p.price.toFixed(2)})`)
      .join(" + ")}`;
  }
  // VARIANT: Decision 5 smallest-safe-implementation choice — no
  // deterministic component sum exists, so price is left null and the
  // draft requires merchant price completion before it can be approved
  // (getApprovalRequirementFailures already enforces this, unchanged).

  // Growth Agent correctness fix — Gemini is never the final authority on
  // whether its price addresses observed demand. Both gates run BEFORE any
  // validateProductInput/Product.create — a rejected proposal creates
  // nothing. Only reachable today for BUNDLE (VARIANT's price is null at
  // this point, per Decision 5 above), but written generically so it keeps
  // holding if that ever changes.
  if (exceedsDemandCeiling(price, policy.priceCeiling)) {
    return {
      error: "PROPOSAL_EXCEEDS_DEMAND_CEILING",
      details: { ceiling: policy.priceCeiling, proposedPrice: price },
    };
  }
  if (actionType === "CREATE_VARIANT" && isNotLowerPriced(price, catalogGap?.cheapestApprovedPrice ?? null)) {
    return {
      error: "PROPOSAL_NOT_LOWER_PRICED",
      details: { cheapestApprovedPrice: catalogGap.cheapestApprovedPrice, proposedPrice: price },
    };
  }

  const { errors, data } = validateProductInput(
    {
      name: proposal.name,
      description,
      category: representative?.category ?? null,
      price: price !== null ? Number(price) : null,
      currency,
    },
    { partial: false, requireCommerceFields: false }
  );
  if (errors.length > 0) {
    return { error: "MERCHANDISING_PROPOSAL_INVALID", details: errors };
  }

  const product = await prisma.product.create({
    data: {
      ...data,
      merchantId,
      sourceType: "AI_OPPORTUNITY",
      originOpportunityId: opportunity.id,
      status: "PENDING_REVIEW",
      // Decision 6: never inferred from component stock.
      stockQuantity: null,
    },
  });

  // Snapshot the current live signal count at the moment of action — never
  // updated again. Lets the UI show "N signals led to this action, M since"
  // without adding a new lifecycle state (still just OPEN/ACTIONED/DISMISSED).
  const signalCountAtAction = await prisma.demandEvent.count({ where: { merchantId, groupKey: opportunity.groupKey } });

  // Growth Agent — frozen the moment the AI proposes this exact product,
  // BEFORE merchant approval (hence "AtProposal"). Historical demand
  // evidence only — never a sales prediction. Left null when the draft has
  // no price yet (a VARIANT-type proposal, price completed later by the
  // merchant) — never guessed at a candidate price to force a number.
  const historicalFit =
    price !== null
      ? await simulateHistoricalFit({
          merchantId,
          category: representative?.category ?? null,
          queryText: representative?.queryText ?? null,
          candidatePrice: Number(price),
        })
      : null;

  await prisma.opportunity.update({
    where: { id: opportunity.id },
    data: {
      status: "ACTIONED",
      actionedAt: new Date(),
      generatedProductId: product.id,
      signalCountAtAction,
      historicalFitTotalAtProposal: historicalFit?.totalHistoricalSignals ?? null,
      historicalFitAddressableAtProposal: historicalFit?.addressableSignals ?? null,
      historicalFitObservedValueAtProposal: historicalFit?.addressableObservedValue ?? null,
      historicalFitComputedAt: historicalFit ? new Date() : null,
    },
  });

  return { product };
}

// Reserved for Layer 9 (closed-loop attribution) — kept here so the module's
// public surface is stable once that layer lands.
export async function getAttributionForProduct(productId) {
  const orderItems = await prisma.orderItem.findMany({
    where: { productId },
    include: { order: true },
  });
  const paidItems = orderItems.filter((item) => item.order.status === "PAID");
  const distinctOrderIds = new Set(paidItems.map((item) => item.orderId));

  let totalMinor = 0n;
  for (const item of paidItems) {
    const [whole, frac = "00"] = item.lineTotal.toFixed(2).split(".");
    totalMinor += BigInt(whole) * 100n + BigInt(frac.padStart(2, "0"));
  }
  const revenue = `${totalMinor / 100n}.${String(totalMinor % 100n).padStart(2, "0")}`;

  return { orderCount: distinctOrderIds.size, revenue: paidItems.length > 0 ? revenue : null };
}
