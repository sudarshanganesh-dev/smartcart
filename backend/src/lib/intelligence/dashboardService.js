import { prisma } from "../prisma.js";
import { toMinorUnits, fromMinorUnits } from "../ai/buyer/cart.js";
import {
  listOpportunitiesForMerchant,
  getOpportunityForMerchant,
  validateGeneratedProductPrice,
} from "./opportunityService.js";
import { getApprovalRequirementFailures } from "../productValidation.js";
import { checkDatabaseConnection } from "../../db/healthCheck.js";
import { getRazorpayConfigStatus } from "../payments/razorpayClient.js";

const RECENT_ACTIVITY_LIMIT = 5;
const STOCK_REASONS = ["OUT_OF_STOCK", "INSUFFICIENT_STOCK"];
const SEVERITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function formatRupees(amount) {
  return `₹${Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Deterministic, template-only — no Gemini call. Every input is a plain
// count/sum already computed by getDashboardSummary from real DB state.
// `totalOpportunities` (every Opportunity ever identified, any status) is
// deliberately the headline figure, not `openCount` — an OPEN count of 0
// does not mean SmartCart found nothing; it can mean everything it found
// has already been actioned. Open/actioned/total are all still exposed
// separately in the `opportunities` DTO field for anything that needs the
// distinction.
function buildSmartCartBrief({ totalOpportunities, pendingAiCount, verifiedAiOrderCount, verifiedAiRevenue }) {
  const opportunitySentence =
    totalOpportunities === 1
      ? "SmartCart has identified 1 growth opportunity."
      : `SmartCart has identified ${totalOpportunities} growth opportunities.`;

  const pendingClause =
    pendingAiCount === 1
      ? "1 AI-generated product is awaiting your review"
      : pendingAiCount > 1
        ? `${pendingAiCount} AI-generated products are awaiting your review`
        : null;

  const revenueClause =
    verifiedAiOrderCount > 0
      ? `SmartCart has generated ${formatRupees(verifiedAiRevenue)} in verified revenue`
      : "no AI-generated revenue has been verified yet";

  const secondSentence = pendingClause ? `${pendingClause}, and ${revenueClause}.` : `${capitalize(revenueClause)}.`;

  return `${opportunitySentence} ${secondSentence}`;
}

// Executive-level queue, not a duplicate ProductList: individual items are
// reserved for the handful of intelligence-grade facts (an AI product's
// price policy state, a repeated stock gap, an open opportunity). Ordinary
// catalog housekeeping — a product missing a required field, or a complete
// product simply waiting for a decision — is aggregated into one summary
// card per bucket instead of one card per product, so a 12-product backlog
// doesn't flood the page. The real issue count is never hidden: it's always
// in the aggregate's own evidence.productCount.
//
// validateGeneratedProductPrice is the SAME check the approval endpoint
// itself runs; getApprovalRequirementFailures is the SAME check the
// approval endpoint itself runs. Severity is a fixed lookup by type, never
// a judgment call, never Gemini-decided.
async function buildAttentionQueue({ merchantId, openList }) {
  const pendingProducts = await prisma.product.findMany({
    where: { merchantId, status: "PENDING_REVIEW" },
    orderBy: { createdAt: "desc" },
  });

  const items = [];
  const missingFieldsProducts = [];
  const ordinaryAwaitingReview = [];

  for (const product of pendingProducts) {
    // AI_OPPORTUNITY products are handled BEFORE ordinary catalog
    // aggregation, always individually — a fresh draft is created with
    // price: null by design (generateDraftForOpportunity's Decision 5:
    // Gemini's response schema has no price field at all), and that must
    // never fold into the same generic "catalog products need completion"
    // bucket as an ordinary manually-entered product missing a field. That
    // would hide the fact SmartCart just did real work.
    if (product.sourceType === "AI_OPPORTUNITY") {
      const missing = getApprovalRequirementFailures(product);

      if (missing.length === 1 && missing[0] === "price") {
        // Structurally valid draft, just needs its merchant-owned price.
        // Ceiling evidence reuses getOpportunityForMerchant's own
        // demandSupportedCeiling — the SAME trusted computation
        // validateGeneratedProductPrice itself checks against — never a
        // second, parallel calculation.
        let demandSupportedCeiling = null;
        if (product.originOpportunityId) {
          const originOpportunity = await getOpportunityForMerchant({ merchantId, opportunityId: product.originOpportunityId });
          demandSupportedCeiling = originOpportunity?.demandSupportedCeiling?.ceiling ?? null;
        }
        items.push({
          type: "AI_PRODUCT_NEEDS_PRICING",
          severity: "MEDIUM",
          title: `${product.name} needs a selling price`,
          explanation: "SmartCart created this product from observed buyer demand. Set a price before it can be reviewed.",
          evidence: { originOpportunityId: product.originOpportunityId, demandSupportedCeiling },
          actionLabel: "Review opportunity",
          actionTarget: { type: "OPPORTUNITY", id: product.originOpportunityId },
        });
        continue;
      }

      if (missing.length > 0) {
        // Genuinely incomplete beyond just price — still an individual,
        // honest item naming every missing field, never silently folded
        // into the ordinary catalog aggregate.
        items.push({
          type: "AI_PRODUCT_MISSING_FIELDS",
          severity: "MEDIUM",
          title: `${product.name} is missing required fields`,
          explanation: `This AI-generated product can't be approved until ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} set.`,
          evidence: { missing },
          actionLabel: "Review product",
          actionTarget: { type: "PRODUCT", id: product.id },
        });
        continue;
      }
    } else {
      const missing = getApprovalRequirementFailures(product);
      if (missing.length > 0) {
        missingFieldsProducts.push({ id: product.id, missing });
        continue;
      }
      ordinaryAwaitingReview.push(product.id);
      continue;
    }

    const candidatePrice = product.price !== null ? Number(product.price) : null;
    const priceCheck = await validateGeneratedProductPrice({ product, candidatePrice });

    if (priceCheck.status === "UNVERIFIABLE") {
      items.push({
        type: "AI_PRICE_POLICY_UNVERIFIABLE",
        severity: "HIGH",
        title: `${product.name} - original demand evidence can't be verified`,
        explanation: "SmartCart can't verify this product's original demand evidence anymore, so it can't be approved as-is.",
        evidence: {},
        actionLabel: "Review product",
        actionTarget: { type: "PRODUCT", id: product.id },
      });
    } else if (priceCheck.status === "CHECKED" && priceCheck.errors.length > 0) {
      items.push({
        type: "AI_PRICE_VIOLATES_DEMAND_POLICY",
        severity: "HIGH",
        title: `${product.name} - price does not match observed demand`,
        explanation: "This AI-generated product's price fails the demand-supported pricing policy and cannot be approved as-is.",
        evidence: { errors: priceCheck.errors },
        actionLabel: "Review product",
        actionTarget: { type: "PRODUCT", id: product.id },
      });
    } else {
      items.push({
        type: "AI_PRODUCT_AWAITING_APPROVAL",
        severity: "MEDIUM",
        title: `${product.name} is awaiting your review`,
        explanation: "SmartCart generated this product from real buyer demand.",
        evidence: { price: product.price !== null ? product.price.toFixed(2) : null },
        actionLabel: "Review product",
        actionTarget: { type: "PRODUCT", id: product.id },
      });
    }
  }

  if (missingFieldsProducts.length > 0) {
    const missingFieldCounts = {};
    for (const { missing } of missingFieldsProducts) {
      for (const field of missing) {
        missingFieldCounts[field] = (missingFieldCounts[field] || 0) + 1;
      }
    }
    items.push({
      type: "CATALOG_REVIEW_REQUIRED",
      severity: "MEDIUM",
      title: `${missingFieldsProducts.length} catalog product${missingFieldsProducts.length === 1 ? "" : "s"} need completion`,
      explanation: "Some pending products are missing information required for approval.",
      evidence: {
        productCount: missingFieldsProducts.length,
        missingFieldCounts,
        sampleProductIds: missingFieldsProducts.slice(0, 5).map((p) => p.id),
      },
      actionLabel: "Review catalog",
      actionTarget: { type: "CATALOG" },
    });
  }

  if (ordinaryAwaitingReview.length > 0) {
    items.push({
      type: "CATALOG_PENDING_REVIEW",
      severity: "LOW",
      title: `${ordinaryAwaitingReview.length} catalog product${ordinaryAwaitingReview.length === 1 ? "" : "s"} awaiting review`,
      explanation: "These products are complete and pending your approval or rejection.",
      evidence: {
        productCount: ordinaryAwaitingReview.length,
        sampleProductIds: ordinaryAwaitingReview.slice(0, 5),
      },
      actionLabel: "Review catalog",
      actionTarget: { type: "CATALOG" },
    });
  }

  for (const opportunity of openList) {
    const isStockReason = STOCK_REASONS.includes(opportunity.reason);
    items.push({
      type: isStockReason ? "REPEATED_STOCK_DEMAND" : "OPEN_OPPORTUNITY_AWAITING_ACTION",
      severity: isStockReason ? "MEDIUM" : "LOW",
      title: opportunity.label ? `Growth opportunity: ${opportunity.label}` : "A new growth opportunity is open",
      explanation: opportunity.whyExplanation,
      evidence: { eventCount: opportunity.eventCount, score: opportunity.score },
      actionLabel: "View opportunity",
      actionTarget: { type: "OPPORTUNITY", id: opportunity.id },
    });
  }

  return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// Pure — no DB, no Prisma types. Deliberately separate from the query below
// so the dedup logic itself (not the query) can be tested directly.
// `items` is one entry per PAID OrderItem that belongs to an AI_OPPORTUNITY
// product; `lineTotal` is already a decimal string ("50.00"). Revenue sums
// every item exactly once (each OrderItem row appears once in the query
// result, full stop). Order count is the size of a Set of orderIds, so an
// order containing two different AI-generated products is still counted
// once — NOT once per product, which is the double-count Feature 2's
// getAttributionForProduct's per-product looping would otherwise produce
// if summed naively across products.
function summarizeAiOrderItems(items) {
  let verifiedMinor = 0;
  const paidOrderIds = new Set();
  for (const item of items) {
    verifiedMinor += toMinorUnits(item.lineTotal);
    paidOrderIds.add(item.orderId);
  }
  return { verifiedMinor, verifiedAiOrderCount: paidOrderIds.size };
}

// A direct merchant-scoped join, not N per-product getAttributionForProduct
// calls — getAttributionForProduct (Feature 2, locked) is correct FOR ONE
// PRODUCT, but summing its orderCount across multiple AI products would
// double-count any order that happens to contain more than one of them.
// This query instead pulls every PAID OrderItem for every AI product in one
// shot and dedupes at the order level via summarizeAiOrderItems above.
async function buildAiRevenueImpact({ merchantId, totalStoreRevenue }) {
  const aiProducts = await prisma.product.findMany({
    where: { merchantId, sourceType: "AI_OPPORTUNITY" },
    select: { id: true },
  });
  const aiProductIds = aiProducts.map((p) => p.id);

  let summary = { verifiedMinor: 0, verifiedAiOrderCount: 0 };
  if (aiProductIds.length > 0) {
    const orderItems = await prisma.orderItem.findMany({
      where: { productId: { in: aiProductIds }, order: { status: "PAID" } },
      select: { orderId: true, lineTotal: true },
    });
    summary = summarizeAiOrderItems(orderItems.map((item) => ({ orderId: item.orderId, lineTotal: item.lineTotal.toFixed(2) })));
  }

  return {
    totalStoreRevenue,
    verifiedAiRevenue: fromMinorUnits(summary.verifiedMinor),
    verifiedAiOrderCount: summary.verifiedAiOrderCount,
    aiProductCount: aiProductIds.length,
  };
}

async function buildCatalogHealth({ merchantId }) {
  const [statusGroups, availabilityGroups, total] = await Promise.all([
    prisma.product.groupBy({ by: ["status"], where: { merchantId }, _count: true }),
    prisma.product.groupBy({ by: ["availability"], where: { merchantId }, _count: true }),
    prisma.product.count({ where: { merchantId } }),
  ]);

  const byStatus = Object.fromEntries(statusGroups.map((g) => [g.status, g._count]));
  const byAvailability = Object.fromEntries(availabilityGroups.map((g) => [g.availability, g._count]));

  return {
    total,
    approved: byStatus.APPROVED || 0,
    pending: byStatus.PENDING_REVIEW || 0,
    rejected: byStatus.REJECTED || 0,
    inStock: byAvailability.IN_STOCK || 0,
    outOfStock: byAvailability.OUT_OF_STOCK || 0,
    unknown: byAvailability.UNKNOWN || 0,
  };
}

// Mirrors health.js's existing honesty discipline exactly: database is a
// real live check; payments/AI are config-presence checks only, never a
// live provider call. "configured" is the strongest claim ever made here —
// never "active", since UI presence alone proves nothing about the agent
// actually running.
async function buildSystemStatus({ aiProductCount, catalogHealth }) {
  const database = await checkDatabaseConnection();
  const paymentsConfigStatus = getRazorpayConfigStatus();
  const aiConfigured = Boolean(process.env.GEMINI_API_KEY);

  return {
    database,
    payments: { configured: paymentsConfigStatus.ok, mode: paymentsConfigStatus.ok ? "test" : "unset" },
    buyerAgent: { configured: aiConfigured },
    growthAgent: { configured: aiConfigured, hasGeneratedDrafts: aiProductCount > 0 },
    catalog: { ready: catalogHealth.approved > 0 },
  };
}

// Phase 8 — read-only aggregation only. Every number here is a direct
// count/sum over existing tables using the project's own established rules
// (PAID-only revenue, exact minor-unit money arithmetic) — nothing here
// changes Order/Opportunity/Product semantics or writes anything.
export async function getDashboardSummary(merchantId) {
  const [approvedCount, pendingCount, paidOrders, openCount, totalOpportunityCount, actionedOpportunities] = await Promise.all([
    prisma.product.count({ where: { merchantId, status: "APPROVED" } }),
    prisma.product.count({ where: { merchantId, status: "PENDING_REVIEW" } }),
    prisma.order.findMany({ where: { merchantId, status: "PAID" }, select: { orderNumber: true, total: true, createdAt: true } }),
    prisma.opportunity.count({ where: { merchantId, status: "OPEN" } }),
    prisma.opportunity.count({ where: { merchantId } }),
    prisma.opportunity.findMany({ where: { merchantId, status: "ACTIONED" }, orderBy: { actionedAt: "desc" } }),
  ]);

  const revenueMinor = paidOrders.reduce((sum, order) => sum + toMinorUnits(order.total.toFixed(2)), 0);

  // Full DTOs for every actioned opportunity, fetched once — reused both to
  // pick the highlighted story and to label the recent-activity feed, so
  // there's no duplicated/inconsistent label logic and no second fetch per use.
  const actionedDetails = await Promise.all(
    actionedOpportunities.map((opportunity) => getOpportunityForMerchant({ merchantId, opportunityId: opportunity.id }))
  );

  // Fetched once, reused for both the highlighted-opportunity fallback below
  // and the "AI buyer demand" panel — already score-sorted desc by
  // listOpportunitiesForMerchant, so top 3 is just the head of this list.
  // No new query logic: every field here is the same, already-audited
  // Opportunity DTO the merchant Opportunities workspace already shows.
  const openList = await listOpportunitiesForMerchant({ merchantId, status: "OPEN" });

  // Highlighted opportunity: prefer a proven, revenue-generating loop over a
  // merely-open one — but only ever real, DB-backed facts, never invented.
  let highlightedOpportunity = actionedDetails.find((detail) => detail?.attribution?.orderCount > 0) || null;
  if (!highlightedOpportunity && openList.length > 0) {
    highlightedOpportunity = await getOpportunityForMerchant({ merchantId, opportunityId: openList[0].id });
  }

  const topDemandSignals = openList.slice(0, 3).map((o) => ({
    id: o.id,
    label: o.label,
    reason: o.reason,
    budgetBand: o.budgetBand,
    eventCount: o.eventCount,
  }));

  // Recent activity: only events with an unambiguous, already-existing
  // timestamp. Deliberately excludes "product approved" — Product.updatedAt
  // changes on any edit, not specifically approval, so it can't be stated
  // truthfully as an approval event.
  const activity = [
    ...paidOrders.map((order) => ({
      type: "ORDER_PAID",
      label: `Order ${order.orderNumber}`,
      amount: order.total.toFixed(2),
      at: order.createdAt,
    })),
    ...actionedOpportunities.map((opportunity, index) => ({
      type: "OPPORTUNITY_ACTIONED",
      label: actionedDetails[index]?.label || "Opportunity",
      at: opportunity.actionedAt,
    })),
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, RECENT_ACTIVITY_LIMIT);

  const totalStoreRevenue = fromMinorUnits(revenueMinor);
  const [attentionQueue, aiRevenueImpact, catalogHealth] = await Promise.all([
    buildAttentionQueue({ merchantId, openList }),
    buildAiRevenueImpact({ merchantId, totalStoreRevenue }),
    buildCatalogHealth({ merchantId }),
  ]);
  const systemStatus = await buildSystemStatus({ aiProductCount: aiRevenueImpact.aiProductCount, catalogHealth });

  const pendingAiCount = attentionQueue.filter(
    (item) => item.type === "AI_PRODUCT_AWAITING_APPROVAL" || item.type === "AI_PRICE_VIOLATES_DEMAND_POLICY" || item.type === "AI_PRICE_POLICY_UNVERIFIABLE"
  ).length;

  const smartCartBrief = buildSmartCartBrief({
    totalOpportunities: totalOpportunityCount,
    pendingAiCount,
    verifiedAiOrderCount: aiRevenueImpact.verifiedAiOrderCount,
    verifiedAiRevenue: aiRevenueImpact.verifiedAiRevenue,
  });

  return {
    generatedAt: new Date().toISOString(),
    products: { approved: approvedCount, pendingReview: pendingCount },
    orders: { paid: paidOrders.length, revenue: totalStoreRevenue },
    opportunities: { total: totalOpportunityCount, open: openCount, actioned: actionedOpportunities.length },
    highlightedOpportunity,
    recentActivity: activity,
    topDemandSignals,
    smartCartBrief,
    attentionQueue,
    aiRevenueImpact,
    catalogHealth,
    systemStatus,
  };
}
