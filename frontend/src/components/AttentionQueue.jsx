import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { formatMoney } from '../lib/formatMoney.js'

// Where to send the merchant for each actionTarget.type. The current
// routing architecture has no URL-addressable "open this one product/
// opportunity" view, so every target lands on the existing workspace that
// owns that kind of record - never a new, duplicate management screen.
const ROUTE_BY_TARGET_TYPE = {
  OPPORTUNITY: '/merchant/opportunities',
  PRODUCT: '/merchant/catalog',
  CATALOG: '/merchant/catalog',
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
          <Link to={ROUTE_BY_TARGET_TYPE[item.actionTarget?.type] || '/merchant/catalog'} className="attention-item__action">
            {item.actionLabel}
            <ArrowRight size={13} strokeWidth={2.25} aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  )
}

export default AttentionQueue
