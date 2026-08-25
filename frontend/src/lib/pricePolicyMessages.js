import { formatMoney } from './formatMoney.js'

// Shared between ProductList.jsx's row-level Approve action and
// OpportunityWorkspace.jsx's Approve Product action — both submit to the
// SAME backend check (validateGeneratedProductPrice in
// opportunityService.js) and must never drift into two different
// explanations of the same real evidence. `price` is the product's own
// current price, already known to the caller from the product/opportunity
// it's already displaying — never re-derived or guessed here.
export function describePriceViolation(detail, price) {
  if (detail.code === 'PRICE_EXCEEDS_DEMAND_CEILING') {
    const subject = price != null ? formatMoney(price) : 'This price'
    return `${subject} exceeds the demand-supported ceiling of ${formatMoney(detail.ceiling)}. This ceiling is supported by ${detail.supportedSignals} of ${detail.knownBudgetSignals} known-budget signals.`
  }
  if (detail.code === 'PRICE_NOT_LOWER_THAN_CATALOG_MATCH') {
    return `This price is not lower than the existing approved product it is meant to undercut (${detail.cheapestApprovedProductName}, ${formatMoney(detail.cheapestApprovedPrice)}).`
  }
  return 'This price does not match observed demand.'
}
