import { Sparkles } from 'lucide-react'
import { REASON_LABELS } from '../lib/opportunityCopy.js'
import { formatMoney } from '../lib/formatMoney.js'

function OpportunityList({ opportunities, onSelect }) {
  if (opportunities.length === 0) {
    return <p className="empty-state">No chances yet. They will show up here as customers shop.</p>
  }

  return (
    <ul className="opportunity-list">
      {opportunities.map((opportunity) => (
        <li key={opportunity.id} className="opportunity-card">
          <button type="button" className="opportunity-card__button" onClick={() => onSelect(opportunity.id)}>
            <p className="opportunity-card__kicker">
              <Sparkles size={12} strokeWidth={2.25} aria-hidden="true" />
              AI Growth Opportunity
            </p>
            <div className="opportunity-card__header">
              <span className="opportunity-card__title">{opportunity.label || 'Buyer demand signal'}</span>
              <span className={`status-badge status-badge--${opportunity.status.toLowerCase()}`}>{opportunity.status}</span>
            </div>
            <p className="opportunity-card__signals">
              {opportunity.eventCount} people wanted this
            </p>
            {opportunity.potentialDemandValue && (
              <p className="opportunity-card__value num-tabular">Possible value: up to {formatMoney(opportunity.potentialDemandValue)}</p>
            )}
            <div className="opportunity-card__footer">
              <span className="opportunity-card__score">Priority {opportunity.score}</span>
              <span className="opportunity-card__reason">{REASON_LABELS[opportunity.reason] || opportunity.reason}</span>
            </div>
            {opportunity.suggestedAction?.label && (
              <p className="opportunity-card__action">AI suggests: {opportunity.suggestedAction.label}</p>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

export default OpportunityList
