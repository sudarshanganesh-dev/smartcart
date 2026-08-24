import { prisma } from "../prisma.js";
import { validateProductInput } from "../productValidation.js";
import { proposeMerchandisingAction } from "./merchandisingProvider.js";
import { toMinorUnits, fromMinorUnits } from "../ai/buyer/cart.js";

const MAX_CANDIDATE_PRODUCTS = 50;
const MIN_BUNDLE_COMPONENTS = 2;

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

function suggestedAction(reason) {
  if (reason === "OUT_OF_STOCK" || reason === "INSUFFICIENT_STOCK") {
    return { type: "VIEW_PRODUCT", label: "View / restock product" };
  }
  return { type: "GENERATE_DRAFT", label: "Generate draft" };
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

// Deterministic, backend-authored explanation — Gemini never sees or
// generates this. Every number in it comes straight from the same trusted
// aggregates already computed for the score/value fields. Wording kept in
// short, everyday English (Phase 8 UX pass) — the underlying facts (count,
// band, reason) are unchanged.
function buildWhyExplanation({ reason, label, budgetBand, eventCount }) {
  const subject = label || "this";
  const people = eventCount === 1 ? "person" : "people";
  const budgetPart = humanizeBudgetBand(budgetBand);

  switch (reason) {
    case "NO_MATCH":
      return `${eventCount} ${people} wanted a ${subject}${budgetPart}. Your store did not have one, so AI suggested a new product.`;
    case "NO_MORE_OPTIONS":
      return `${eventCount} ${people} wanted more choices for ${subject}${budgetPart} after seeing what you already sell.`;
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

async function labelFor(reason, representative) {
  if (!representative) return null;
  if (reason === "OUT_OF_STOCK" || reason === "INSUFFICIENT_STOCK") {
    if (!representative.productId) return null;
    const product = await prisma.product.findUnique({ where: { id: representative.productId }, select: { name: true } });
    return product ? product.name : null;
  }
  return representative.category || representative.queryText || null;
}

// `representative` is the most recent DemandEvent for this group (or null)
// — used only to surface human-readable intent context (budget band,
// requested quantity/stock gap); every COUNT/SUM number still comes from
// `stats`, never from this single row.
function toOpportunityListDTO(opportunity, stats, label, representative) {
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
    whyExplanation: buildWhyExplanation({ reason: opportunity.reason, label, budgetBand, eventCount: stats.eventCount }),
    suggestedAction: suggestedAction(opportunity.reason),
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
      const label = await labelFor(o.reason, representative);
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
  const label = await labelFor(opportunity.reason, recentEvents[0]);
  const listDTO = toOpportunityListDTO(opportunity, opportunityStats, label, recentEvents[0]);

  let generatedProduct = null;
  let attribution = null;
  if (opportunity.generatedProductId) {
    // Deliberately re-reads live product status — a rejected or deleted
    // draft must be shown honestly, never as a stale "actioned" success.
    const product = await prisma.product.findUnique({ where: { id: opportunity.generatedProductId } });
    generatedProduct = product
      ? { id: product.id, name: product.name, status: product.status, price: product.price ? product.price.toFixed(2) : null }
      : { id: opportunity.generatedProductId, deleted: true };
    // Closed-loop attribution (Decision 12): only ever computed from real
    // PAID OrderItems referencing this exact generated product id — never
    // claimed for a Conversion Recovery alternative.
    attribution = await getAttributionForProduct(opportunity.generatedProductId);
  }

  return {
    ...listDTO,
    recentExamples: recentEvents.map(toDemandEventExampleDTO),
    generatedProduct,
    attribution,
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

  const [stats, representative, candidateProducts] = await Promise.all([
    loadStatsByGroupKey(merchantId),
    prisma.demandEvent.findFirst({ where: { merchantId, groupKey: opportunity.groupKey }, orderBy: { createdAt: "desc" } }),
    prisma.product.findMany({ where: { merchantId, status: "APPROVED" }, take: MAX_CANDIDATE_PRODUCTS }),
  ]);

  if (candidateProducts.length === 0) {
    return { error: "MERCHANDISING_PROPOSAL_INVALID" };
  }

  const opportunityStats = stats.get(opportunity.groupKey) || { eventCount: 0 };
  const label = await labelFor(opportunity.reason, representative);

  const result = await proposeMerchandisingAction({
    opportunitySummary: {
      reason: opportunity.reason,
      label,
      eventCount: opportunityStats.eventCount,
      maxPrice: representative?.maxPrice ? representative.maxPrice.toFixed(2) : null,
    },
    candidateProducts: candidateProducts.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      currency: p.currency,
      price: p.price ? p.price.toFixed(2) : null,
    })),
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

  await prisma.opportunity.update({
    where: { id: opportunity.id },
    data: { status: "ACTIONED", actionedAt: new Date(), generatedProductId: product.id, signalCountAtAction },
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
