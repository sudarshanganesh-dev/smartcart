import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'
import { REASON_LABELS, humanizeBudgetBand } from '../lib/opportunityCopy.js'

// Merchant Overview's "AI buyer demand" panel — every row is a real,
// already-audited Opportunity (see dashboardService.js's topDemandSignals),
// the same data the Opportunities workspace shows. No counts, trends, or
// percentages are invented here; an empty list shows an honest empty state.
function DemandPulse({ signals }) {
  return (
    <div className="demand-pulse">
      <h3 className="demand-pulse__title">AI buyers are looking for</h3>

      {signals.length === 0 ? (
        <p className="empty-state">No AI buyer demand yet — it will show up here as customers shop.</p>
      ) : (
        <ul className="demand-pulse__list">
          {signals.map((signal) => (
            <li key={signal.id} className="demand-pulse__item">
              <span className="demand-pulse__icon" aria-hidden="true">
                <Search size={14} strokeWidth={2} />
              </span>
              <span className="demand-pulse__text">
                <span className="demand-pulse__label">
                  {signal.label || REASON_LABELS[signal.reason] || 'Something buyers wanted'}
                  {humanizeBudgetBand(signal.budgetBand)}
                </span>
                <span className="field-hint">
                  {signal.eventCount} request{signal.eventCount === 1 ? '' : 's'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <Link to="/merchant/opportunities" className="demand-pulse__link">
        View Opportunities
      </Link>
    </div>
  )
}

export default DemandPulse
