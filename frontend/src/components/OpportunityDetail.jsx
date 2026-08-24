import { ArrowLeft, Sparkles } from 'lucide-react'
import LoopTracker from './LoopTracker.jsx'
import { buildOpportunityLoopSteps } from '../lib/opportunityLoop.js'
import { REASON_LABELS, RECOMMENDATION_TEXT } from '../lib/opportunityCopy.js'
import { formatMoney } from '../lib/formatMoney.js'

function formatDateTime(iso) {
  return new Date(iso).toLocaleString()
}

function ExampleLine({ example }) {
  const parts = []
  if (example.category) parts.push(`Category: ${example.category}`)
  if (example.queryText) parts.push(`Search: "${example.queryText}"`)
  if (example.maxPrice) parts.push(`Budget: up to ${formatMoney(example.maxPrice)}`)
  else if (example.budgetBand && example.budgetBand !== 'none') parts.push(`Budget: ${example.budgetBand}`)
  if (example.requestedQuantity != null) {
    parts.push(
      `Wanted: ${example.requestedQuantity}${example.availableQuantity != null ? ` (had: ${example.availableQuantity})` : ''}`
    )
  }
  return (
    <li className="opportunity-detail__example">
      <span>{parts.join(' · ') || 'Buyer demand signal'}</span>
      <span className="field-hint">{formatDateTime(example.createdAt)}</span>
    </li>
  )
}

function OpportunityDetail({ opportunity, loading, error, onBack, onRetry, onDismiss, onGenerateDraft, actionState, actionError }) {
  return (
    <div className="opportunity-detail">
      <button type="button" className="link-button" onClick={onBack}>
        <ArrowLeft size={14} strokeWidth={2.25} aria-hidden="true" />
        Back to opportunities
      </button>

      {loading && <p>Loading opportunity…</p>}

      {!loading && error && (
        <div className="error-banner">
          <p>{error}</p>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && opportunity && (
        <>
          <p className="opportunity-detail__kicker">
            <Sparkles size={13} strokeWidth={2.25} aria-hidden="true" />
            AI Growth Opportunity
          </p>
          <div className="opportunity-detail__header">
            <h3>{opportunity.label || 'Buyer demand signal'}</h3>
            <span className={`status-badge status-badge--${opportunity.status.toLowerCase()}`}>{opportunity.status}</span>
          </div>

          <p className="opportunity-detail__reason">Reason: {REASON_LABELS[opportunity.reason] || opportunity.reason}</p>

          {opportunity.whyExplanation && <p className="opportunity-detail__why">{opportunity.whyExplanation}</p>}

          <div className="opportunity-detail__loop">
            <h4>How this happened</h4>
            <LoopTracker steps={buildOpportunityLoopSteps(opportunity)} />
          </div>

          {RECOMMENDATION_TEXT[opportunity.reason] && (
            <p className="opportunity-detail__recommendation">
              <strong>AI suggests:</strong> {RECOMMENDATION_TEXT[opportunity.reason]}
            </p>
          )}

          <dl className="order-detail__summary">
            <div>
              <dt>People asked</dt>
              <dd>{opportunity.eventCount}</dd>
            </div>
            <div>
              <dt>In the last 7 days</dt>
              <dd>{opportunity.recentEventCount7d}</dd>
            </div>
            {opportunity.intentSummary && (
              <div>
                <dt>What they wanted</dt>
                <dd>{opportunity.intentSummary}</dd>
              </div>
            )}
            {opportunity.potentialDemandValue && (
              <div>
                <dt>Possible value</dt>
                <dd>up to {formatMoney(opportunity.potentialDemandValue)} (not guaranteed)</dd>
              </div>
            )}
            <div>
              <dt>First seen</dt>
              <dd>{formatDateTime(opportunity.firstSeenAt)}</dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>{formatDateTime(opportunity.lastSeenAt)}</dd>
            </div>
            {opportunity.signalsBeforeAction != null && (
              <div>
                <dt>Before / after AI acted</dt>
                <dd>
                  {opportunity.signalsBeforeAction} before · {opportunity.signalsSinceAction} after
                </dd>
              </div>
            )}
          </dl>

          <h4>Priority score: {opportunity.score}</h4>
          <p className="field-hint">
            {opportunity.eventCount} people asked × 2 = {opportunity.scoreBreakdown.frequencyPoints}
            <br />
            {opportunity.recentEventCount7d} asked in the last 7 days = {opportunity.scoreBreakdown.recencyPoints}
            <br />
            How urgent ({REASON_LABELS[opportunity.reason] || opportunity.reason}) = {opportunity.scoreBreakdown.severityPoints}
            <br />
            Total = {opportunity.scoreBreakdown.total}
          </p>

          <h4>Recent requests</h4>
          <ul className="opportunity-detail__examples">
            {opportunity.recentExamples.map((example, index) => (
              <ExampleLine key={index} example={example} />
            ))}
          </ul>

          {opportunity.generatedProduct && (
            <div className="opportunity-detail__generated">
              <h4>AI-made product</h4>
              <p>
                {opportunity.generatedProduct.deleted
                  ? 'This product was removed.'
                  : `${opportunity.generatedProduct.name} — ${opportunity.generatedProduct.status.replace('_', ' ').toLowerCase()}${
                      opportunity.generatedProduct.price ? ` · ${formatMoney(opportunity.generatedProduct.price)}` : ''
                    }`}
              </p>
              {opportunity.attribution?.revenue && (
                <p className="opportunity-card__value">
                  Money earned: {formatMoney(opportunity.attribution.revenue)} from {opportunity.attribution.orderCount} order
                  {opportunity.attribution.orderCount === 1 ? '' : 's'}
                </p>
              )}
            </div>
          )}

          {actionError && (
            <div className="error-banner">
              <p>{actionError}</p>
            </div>
          )}

          {opportunity.status === 'OPEN' && (
            <div className="product-form__actions">
              {opportunity.suggestedAction.type === 'GENERATE_DRAFT' && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={onGenerateDraft}
                  disabled={actionState === 'generating' || actionState === 'dismissing'}
                >
                  {actionState === 'generating' ? 'Making product…' : 'Make a product with AI'}
                </button>
              )}
              <button type="button" onClick={onDismiss} disabled={actionState === 'generating' || actionState === 'dismissing'}>
                {actionState === 'dismissing' ? 'Dismissing…' : 'Dismiss'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default OpportunityDetail
