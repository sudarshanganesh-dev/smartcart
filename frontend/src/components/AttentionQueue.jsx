import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { formatMoney } from '../lib/formatMoney.js'

// Where to send the merchant for each actionTarget.type. OPPORTUNITY now
// deep-links straight to that one opportunity (OpportunityWorkspace reads
// ?id= on mount) instead of only the bare list - a small, safe addition to
// the existing workspace, not a new page. PRODUCT/CATALOG still land on the
// existing Catalog workspace - there is no URL-addressable single-product
// view today, and this pass does not add one.
function routeForTarget(actionTarget) {
  if (actionTarget?.type === 'OPPORTUNITY' && actionTarget.id) {
    return `/merchant/opportunities?id=${encodeURIComponent(actionTarget.id)}`
  }
  // PRODUCT, CATALOG, and any unrecognized target all land on the existing
  // Catalog workspace - there is no URL-addressable single-product view
  // today, and this pass does not add one.
  return '/merchant/catalog'
}

// Renders only what the backend's evidence object actually contains - never
// a guessed or recalculated figure. Each attentionQueue item type has its
// own, deliberately small, evidence shape (see dashboardService.js).
function EvidenceList({ item }) {
  const facts = []

  if (item.type === 'AI_PRICE_VIOLATES_DEMAND_POLICY') {
    for (const error of item.evidence?.errors || []) {
      if (error.code === 'PRICE_EXCEEDS_DEMAND_CEILING') {
        facts.push(`Demand-supported ceiling: ${formatMoney(error.ceiling)}`)
        facts.push(`Supported by ${error.supportedSignals} of ${error.knownBudgetSignals} known-budget signals`)
      } else if (error.code === 'PRICE_NOT_LOWER_THAN_CATALOG_MATCH') {
        facts.push(`Not lower than ${error.cheapestApprovedProductName} (${formatMoney(error.cheapestApprovedPrice)})`)
      }
    }
  } else if (item.type === 'AI_PRODUCT_AWAITING_APPROVAL' && item.evidence?.price != null) {
    facts.push(`Price: ${formatMoney(item.evidence.price)}`)
  } else if (item.type === 'AI_PRODUCT_NEEDS_PRICING' && item.evidence?.demandSupportedCeiling != null) {
    facts.push(`Demand-supported ceiling: ${formatMoney(item.evidence.demandSupportedCeiling)}`)
  } else if (item.type === 'AI_PRODUCT_MISSING_FIELDS' && item.evidence?.missing) {
    facts.push(item.evidence.missing.join(', '))
  } else if (item.type === 'CATALOG_REVIEW_REQUIRED' && item.evidence?.missingFieldCounts) {
    const breakdown = Object.entries(item.evidence.missingFieldCounts)
      .map(([field, count]) => `${field}: ${count}`)
      .join(', ')
    if (breakdown) facts.push(breakdown)
  } else if (item.type === 'REPEATED_STOCK_DEMAND' || item.type === 'OPEN_OPPORTUNITY_AWAITING_ACTION') {
    if (item.evidence?.eventCount != null) {
      facts.push(`${item.evidence.eventCount} signal${item.evidence.eventCount === 1 ? '' : 's'} - score ${item.evidence.score}`)
    }
  }

  if (facts.length === 0) return null

  return (
    <ul className="attention-item__evidence">
      {facts.map((fact, index) => (
        <li key={index}>{fact}</li>
      ))}
    </ul>
  )
}

function AttentionQueue({ items }) {
  if (items.length === 0) {
    return <p className="success-banner">Nothing needs your attention right now.</p>
  }

  return (
    <ul className="attention-queue">
      {items.map((item, index) => (
        <li
          key={`${item.type}:${item.actionTarget?.type || ''}:${item.actionTarget?.id ?? index}`}
          className={`attention-item attention-item--${item.severity.toLowerCase()}`}
        >
          <div className="attention-item__header">
            <span className="attention-item__severity">{item.severity}</span>
            <h4 className="attention-item__title">{item.title}</h4>
          </div>
          <p className="attention-item__explanation">{item.explanation}</p>
          <EvidenceList item={item} />
          <Link to={routeForTarget(item.actionTarget)} className="attention-item__action">
            {item.actionLabel}
            <ArrowRight size={13} strokeWidth={2.25} aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  )
}

export default AttentionQueue
