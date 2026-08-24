import { prisma } from "../prisma.js";
import { toMinorUnits, fromMinorUnits } from "../ai/buyer/cart.js";
import { listOpportunitiesForMerchant, getOpportunityForMerchant } from "./opportunityService.js";

const RECENT_ACTIVITY_LIMIT = 5;

// Phase 8 — read-only aggregation only. Every number here is a direct
// count/sum over existing tables using the project's own established rules
// (PAID-only revenue, exact minor-unit money arithmetic) — nothing here
// changes Order/Opportunity/Product semantics or writes anything.
export async function getDashboardSummary(merchantId) {
  const [approvedCount, pendingCount, paidOrders, openCount, actionedOpportunities] = await Promise.all([
    prisma.product.count({ where: { merchantId, status: "APPROVED" } }),
    prisma.product.count({ where: { merchantId, status: "PENDING_REVIEW" } }),
    prisma.order.findMany({ where: { merchantId, status: "PAID" }, select: { orderNumber: true, total: true, createdAt: true } }),
    prisma.opportunity.count({ where: { merchantId, status: "OPEN" } }),
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

  return {
    products: { approved: approvedCount, pendingReview: pendingCount },
    orders: { paid: paidOrders.length, revenue: fromMinorUnits(revenueMinor) },
    opportunities: { open: openCount, actioned: actionedOpportunities.length },
    highlightedOpportunity,
    recentActivity: activity,
    topDemandSignals,
  };
}
