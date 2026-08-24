import { formatMoney } from './formatMoney.js'

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
