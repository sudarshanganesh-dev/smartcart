import { formatMoney } from './formatMoney.js'

// Frontend mirror of the backend's isProductPurchasable
// (opportunityService.js) — kept as an independent copy rather than shared
// code, the same way the backend itself keeps its own copy independent of
// planOptimizer.js. Correction 2: "approved" and "available" are
// deliberately two different facts — a product can be APPROVED and still
// OUT_OF_STOCK, so this must never be inferred from status alone.
function isProductPurchasable(product) {
  if (!product) return false
  return product.availability === 'IN_STOCK' && (product.stockQuantity === null || product.stockQuantity >= 1)
}

const STOCK_REASONS = new Set(['OUT_OF_STOCK', 'INSUFFICIENT_STOCK'])

// Growth Agent correctness fix — for an ACTIONED, catalog-gap-reason
// opportunity, opportunity.suggestedAction is recomputed LIVE from the
// current catalog (post-action), never frozen at the moment SmartCart
// actually proposed the draft. Since no actionTypeAtProposal is persisted,
// the Growth Feed must never present that live label as historical
// evidence of what was proposed — it uses a generic, truthfully weaker
// phrase instead. OPEN opportunities keep the live label, since there it
// genuinely describes the current recommendation, not a historical claim.
function buildProposedActionValue(opportunity, isStockReason) {
  if (isStockReason || opportunity.status !== 'ACTIONED') {
    return opportunity.suggestedAction?.label || null
  }
  const product = opportunity.generatedProduct
  if (product && !product.deleted) return `${product.name} proposed`
  return 'AI product proposed'
}

// Single source of truth for deriving the closed-loop steps from an
// opportunity DTO — used by both OverviewPage and OpportunityDetail so the
// "wow" visual can never disagree with itself between the two pages. Every
// `done`/`value` is derived strictly from real backend fields. Wording kept
// short and everyday (Phase 8 UX pass) — the underlying facts are unchanged.
export function buildOpportunityLoopSteps(opportunity) {
  return [
    { label: 'People asked', done: true, value: `${opportunity.eventCount} request${opportunity.eventCount === 1 ? '' : 's'}` },
    { label: 'AI made product', done: Boolean(opportunity.generatedProductId) },
    { label: 'You approved', done: opportunity.generatedProduct?.status === 'APPROVED' },
    {
      label: 'Customer bought',
      done: opportunity.attribution?.orderCount > 0,
      value: opportunity.attribution?.orderCount > 0 ? `${opportunity.attribution.orderCount} order${opportunity.attribution.orderCount === 1 ? '' : 's'}` : null,
    },
    {
      label: 'Money earned',
      done: Boolean(opportunity.attribution?.revenue),
      value: opportunity.attribution?.revenue ? formatMoney(opportunity.attribution.revenue) : null,
    },
  ]
}

// Feature 2 — the 7-stage Growth Feed: Demand detected → Opportunity
// created → AI action proposed → Merchant approved → Product available →
// Customer purchased → Revenue attributed. Every done/value comes strictly
// from real backend fields, same discipline as buildOpportunityLoopSteps
// above (left completely untouched by this addition).
//
// Stock-reason opportunities (OUT_OF_STOCK / INSUFFICIENT_STOCK) never
// generate a new product — generateDraftForOpportunity refuses them
// (OPPORTUNITY_NOT_ACTIONABLE) — so there is no backend signal that proves
// the merchant restocked BECAUSE of this specific opportunity. Rather than
// inferring "merchant approved" from current stock being available again,
// that step is honestly left not-done with a note explaining why it can't
// be confirmed, while "Product available" still reports the real current
// stock state as its own separate, honest fact.
export function buildGrowthFeedSteps(opportunity) {
  const isStockReason = STOCK_REASONS.has(opportunity.reason)
  const product = isStockReason ? opportunity.relatedProduct : opportunity.generatedProduct
  const available = isProductPurchasable(product)

  return [
    {
      label: 'Demand detected',
      done: true,
      value: `${opportunity.eventCount} signal${opportunity.eventCount === 1 ? '' : 's'}`,
    },
    { label: 'Opportunity created', done: true },
    {
      label: 'AI action proposed',
      done: Boolean(opportunity.suggestedAction),
      value: buildProposedActionValue(opportunity, isStockReason),
    },
    isStockReason
      ? { label: 'Merchant approved', done: false, value: "Can't be confirmed from stock data alone" }
      : { label: 'Merchant approved', done: product?.status === 'APPROVED' },
    {
      label: 'Product available',
      done: available,
      value: product && !product.deleted ? (available ? 'In stock' : 'Not currently purchasable') : null,
    },
    {
      label: 'Customer purchased',
      done: opportunity.attribution?.orderCount > 0,
      value:
        opportunity.attribution?.orderCount > 0
          ? `${opportunity.attribution.orderCount} order${opportunity.attribution.orderCount === 1 ? '' : 's'}`
          : null,
    },
    {
      label: 'Revenue attributed',
      done: Boolean(opportunity.attribution?.revenue),
      value: opportunity.attribution?.revenue ? formatMoney(opportunity.attribution.revenue) : null,
    },
  ]
}
