import { useState } from 'react'
import { ArrowLeft, Sparkles, CheckCircle2, AlertTriangle } from 'lucide-react'
import { Link } from 'react-router-dom'
import LoopTracker from './LoopTracker.jsx'
import { buildGrowthFeedSteps } from '../lib/opportunityLoop.js'
import { REASON_LABELS, DRAFT_ELIGIBLE_ACTION_TYPES, RESTOCK_ACTION_TYPES } from '../lib/opportunityCopy.js'
import { formatMoney } from '../lib/formatMoney.js'

const STOCK_REASONS = new Set(['OUT_OF_STOCK', 'INSUFFICIENT_STOCK'])

function formatDateTime(iso) {
  return new Date(iso).toLocaleString()
}

function isProductPurchasable(product) {
  if (!product) return false
  return product.availability === 'IN_STOCK' && (product.stockQuantity === null || product.stockQuantity >= 1)
}

function formatStatusLabel(status) {
  const words = status.replace(/_/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
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

// Shared rendering for the related product on a stock-reason opportunity —
// name/price/status/availability together, since none of those facts are in
// dispute there (the product already existed; nothing was "created").
function ProductLine({ product }) {
  if (!product) return null
  if (product.deleted) return <p>This product was removed.</p>
  const available = isProductPurchasable(product)
  return (
    <p>
      {product.name} - {formatStatusLabel(product.status).toLowerCase()}
      {product.price ? ` · ${formatMoney(product.price)}` : ''}
      {' · '}
      {available ? 'In stock' : 'Not currently available'}
    </p>
  )
}

// ACTIONED story only: the creation fact (what SmartCart made) kept
// separate from the current-state fact (its live status/availability) —
// the two are deliberately never collapsed into one line here.
function CreatedProductLine({ product }) {
  if (!product) return null
  if (product.deleted) return <p>This product was removed.</p>
  return (
    <p>
      Created <strong>{product.name}</strong>
      {product.price ? ` at ${formatMoney(product.price)}` : ' (price not yet set)'}.
    </p>
  )
}

function CurrentStateLine({ product }) {
  if (!product || product.deleted) return null
  const available = isProductPurchasable(product)
  return (
    <p>
      {formatStatusLabel(product.status)} · {available ? 'In stock' : 'Not currently available'}
    </p>
  )
}

function ReadinessFlags({ flags }) {
  if (!flags || flags.length === 0) return null
  return (
    <ul className="readiness-flags">
      {flags.map((flag) => {
        const Icon = flag.ok ? CheckCircle2 : AlertTriangle
        return (
          <li key={flag.key} className={`readiness-flags__item ${flag.ok ? 'readiness-flags__item--ok' : 'readiness-flags__item--warn'}`}>
            <Icon size={14} strokeWidth={2.25} aria-hidden="true" />
            <span>{flag.label}</span>
          </li>
        )
      })}
    </ul>
  )
}

const AVAILABILITY_OPTIONS = [
  { value: 'UNKNOWN', label: 'Unknown' },
  { value: 'IN_STOCK', label: 'In stock' },
  { value: 'OUT_OF_STOCK', label: 'Out of stock' },
]

// A fresh AI-generated draft is created with price: null, availability:
// UNKNOWN, stockQuantity: null by design (generateDraftForOpportunity's
// Decision 5/6 — Gemini's response schema has no price field, and stock is
// never inferred from anything) — the merchant always sets all three
// themselves. Lets that happen right here instead of a Catalog detour.
// Submitted together through the EXACT SAME PATCH endpoint Catalog's own
// edit form uses, which re-runs validateGeneratedProductPrice server-side —
// this form never validates anything itself, it only submits what the
// merchant chose. Availability starts at the product's OWN current value
// (UNKNOWN for a fresh draft) — never silently defaulted to IN_STOCK; the
// merchant must actively choose it.
function ProductSetupForm({ product, ceiling, onSave, actionState }) {
  const [price, setPrice] = useState(product.price != null ? String(product.price) : '')
  const [availability, setAvailability] = useState(product.availability)
  const [stockQuantity, setStockQuantity] = useState(product.stockQuantity != null ? String(product.stockQuantity) : '')
  const saving = actionState === 'savingSetup'

  function handleSubmit(event) {
    event.preventDefault()
    const parsedPrice = Number(price)
    if (price.trim() === '' || Number.isNaN(parsedPrice) || parsedPrice < 0) return

    const payload = { price: parsedPrice, availability }
    // IN_STOCK requires a stated quantity of at least 1 here (a form-level
    // nudge, not a new backend rule - getApprovalRequirementFailures never
    // required this) - IN_STOCK + 0 would contradict the customer-side
    // purchasability rule (ProductCard/add-to-cart treat IN_STOCK as
    // purchasable only when stockQuantity is null or >= 1). OUT_OF_STOCK/
    // UNKNOWN pass through exactly what the merchant typed, or null if left
    // blank - never silently rewritten.
    if (availability === 'IN_STOCK') {
      const parsedStock = Number(stockQuantity)
      if (stockQuantity.trim() === '' || !Number.isInteger(parsedStock) || parsedStock < 1) return
      payload.stockQuantity = parsedStock
    } else {
      payload.stockQuantity = stockQuantity.trim() === '' ? null : Number(stockQuantity)
    }

    onSave(payload)
  }

  return (
    <div className="opportunity-detail__section">
      <h4 className="opportunity-detail__section-title">Product Setup</h4>
      {ceiling != null && <p className="field-hint">Demand-supported ceiling: {formatMoney(ceiling)}</p>}
      <form className="product-form" onSubmit={handleSubmit}>
        <div className="product-form__row">
          <label>
            Selling price
            <input type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} disabled={saving} />
          </label>
          <label>
            Availability
            <select value={availability} onChange={(e) => setAvailability(e.target.value)} disabled={saving}>
              {AVAILABILITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Stock quantity{availability === 'IN_STOCK' ? ' *' : ''}
          <input
            type="number"
            step="1"
            min={availability === 'IN_STOCK' ? 1 : 0}
            value={stockQuantity}
            onChange={(e) => setStockQuantity(e.target.value)}
            disabled={saving}
            required={availability === 'IN_STOCK'}
          />
        </label>
        <div className="product-form__actions">
          <button type="submit" className="btn-primary" disabled={saving || price.trim() === ''}>
            {saving ? 'Saving…' : 'Save product setup'}
          </button>
        </div>
      </form>
    </div>
  )
}

// Historical demand evidence — deliberately careful wording (never "will
// sell", never a percentage): this is a record of what past requests would
// have fit, not a forecast.
function HistoricalFitLine({ fit, productName, productPrice }) {
  if (!fit) return null
  return (
    <div>
      {productName && (
        <p className="field-hint">
          {productName}
          {productPrice ? ` - ${formatMoney(productPrice)}` : ''}
        </p>
      )}
      <p className="field-hint">
        {fit.addressable} of {fit.total} past unmet request{fit.total === 1 ? '' : 's'} would have fit this product.
        {fit.observedValue ? ` Recorded budget represented: up to ${formatMoney(fit.observedValue)}.` : ''} Historical demand only,
        not predicted sales.
      </p>
    </div>
  )
}

// Everything a merchant needs for explainability/support, but none of it
// competes with the primary demand → action → outcome story above it.
function CalculationDisclosure({ opportunity, historicalFit }) {
  return (
    <details className="opportunity-detail__calc">
      <summary>How SmartCart calculated this</summary>
      <div className="opportunity-detail__calc-body">
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

        {opportunity.demandConcentration && opportunity.demandConcentration.length > 1 && (
          <div className="opportunity-detail__concentration">
            <h4>Where the demand is concentrated</h4>
            <ul>
              {opportunity.demandConcentration.map((band) => (
                <li key={band.band}>
                  <span>{band.band === opportunity.budgetBand ? <strong>{band.band}</strong> : band.band}</span>
                  <span className="num-tabular">
                    {band.count} signal{band.count === 1 ? '' : 's'} ({band.sharePercent}%)
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Action Readiness is deliberately NEVER shown here. Its flags are
            always computed from live/current catalog state (see
            buildActionReadiness in opportunityService.js) — for an OPEN
            opportunity that's shown prominently above instead (see the OPEN
            branch), and for ACTIONED/DISMISSED it would misrepresent
            current-state facts as evidence available at the time SmartCart
            acted, which nothing here proves. */}

        {historicalFit && (
          <div>
            <h4>Historical Demand Test</h4>
            <HistoricalFitLine
              fit={historicalFit}
              productName={opportunity.generatedProduct?.name}
              productPrice={opportunity.generatedProduct?.price}
            />
          </div>
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

        <h4>Recent requests</h4>
        <ul className="opportunity-detail__examples">
          {opportunity.recentExamples.map((example, index) => (
            <ExampleLine key={index} example={example} />
          ))}
        </ul>
      </div>
    </details>
  )
}

function OpportunityDetail({
  opportunity,
  loading,
  error,
  onBack,
  onRetry,
  onDismiss,
  onGenerateDraft,
  onApproveProduct,
  onRejectProduct,
  onSaveProductSetup,
  actionState,
  actionError,
}) {
  if (loading || error || !opportunity) {
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
      </div>
    )
  }

  const isStockReason = STOCK_REASONS.has(opportunity.reason)
  const brief = opportunity.growthBrief
  const generatedProduct = opportunity.generatedProduct && !opportunity.generatedProduct.deleted ? opportunity.generatedProduct : null
  const isDraftPending = generatedProduct?.status === 'PENDING_REVIEW'
  const historicalFit = opportunity.historicalFitAtProposal
  const isOpen = opportunity.status === 'OPEN'
  const isActioned = opportunity.status === 'ACTIONED'
  const isDismissed = opportunity.status === 'DISMISSED'

  return (
    <div className="opportunity-detail">
      <button type="button" className="link-button" onClick={onBack}>
        <ArrowLeft size={14} strokeWidth={2.25} aria-hidden="true" />
        Back to opportunities
      </button>

      <p className="opportunity-detail__kicker">
        <Sparkles size={13} strokeWidth={2.25} aria-hidden="true" />
        AI Growth Opportunity
      </p>
      <div className="opportunity-detail__header">
        <h3>{opportunity.label || 'Buyer demand signal'}</h3>
        <span className={`status-badge status-badge--${opportunity.status.toLowerCase()}`}>{opportunity.status}</span>
      </div>
      <p className="opportunity-detail__reason">Reason: {REASON_LABELS[opportunity.reason] || opportunity.reason}</p>

      {/* DEMAND DETECTED — shown for every status; the one truthful,
          reason-derived fact that never depends on live catalog state. */}
      <div className="opportunity-detail__section">
        <h4 className="opportunity-detail__section-title">Demand Detected</h4>
        {opportunity.whyExplanation && <p>{opportunity.whyExplanation}</p>}
        {brief && (
          <p className="field-hint">
            {brief.demand.total} total signal{brief.demand.total === 1 ? '' : 's'} · {brief.demand.recent7d} in the last 7 days
            {brief.budgetPattern ? ` · ${brief.budgetPattern}` : ''}
          </p>
        )}
      </div>

      {/* OPEN — forward-looking: catalog gap → recommendation → readiness → action */}
      {isOpen && (
        <>
          {!isStockReason && opportunity.catalogGap?.hasApprovedMatch && (
            <div className="opportunity-detail__section">
              <h4 className="opportunity-detail__section-title">Current Catalog Gap</h4>
              <p>{opportunity.catalogGap.explanation}</p>
            </div>
          )}
          {!isStockReason && opportunity.catalogGap && !opportunity.catalogGap.hasApprovedMatch && (
            <div className="opportunity-detail__section">
              <h4 className="opportunity-detail__section-title">Current Catalog Gap</h4>
              <p>You have no approved product matching this yet.</p>
            </div>
          )}
          {!isStockReason && opportunity.reason === 'NO_MORE_OPTIONS' && opportunity.existingOptionCount != null && (
            <p className="field-hint">
              You already have {opportunity.existingOptionCount} approved option{opportunity.existingOptionCount === 1 ? '' : 's'} in
              this category, and buyers are asking for more.
            </p>
          )}
          {isStockReason && (
            <div className="opportunity-detail__section">
              <h4 className="opportunity-detail__section-title">Stock Evidence</h4>
              {opportunity.relatedProduct && <ProductLine product={opportunity.relatedProduct} />}
              {opportunity.stockGap != null && (
                <p className="field-hint">Buyers most recently wanted {opportunity.stockGap} more than you had available.</p>
              )}
              {opportunity.potentialDemandValue && (
                <p className="field-hint">Observed demand value: up to {formatMoney(opportunity.potentialDemandValue)} (not guaranteed).</p>
              )}
            </div>
          )}

          {opportunity.suggestedAction?.label && (
            <p className="opportunity-detail__recommendation">
              <strong>SmartCart recommends:</strong> {opportunity.suggestedAction.label}
            </p>
          )}

          {!isStockReason && opportunity.actionReadiness?.flags?.length > 0 && (
            <div className="opportunity-detail__section">
              <h4 className="opportunity-detail__section-title">Action Readiness</h4>
              <ReadinessFlags flags={opportunity.actionReadiness.flags} />
              <p className="field-hint">Ready for merchant review.</p>
            </div>
          )}
        </>
      )}

      {/* ACTIONED — past-tense closed-loop story */}
      {isActioned && (
        <>
          <div className="opportunity-detail__section">
            <h4 className="opportunity-detail__section-title">SmartCart Action</h4>
            <CreatedProductLine product={generatedProduct} />
            {!generatedProduct && opportunity.generatedProduct?.deleted && <p>This product was removed.</p>}
          </div>

          {generatedProduct && (
            <div className="opportunity-detail__section">
              <h4 className="opportunity-detail__section-title">Current State</h4>
              <CurrentStateLine product={generatedProduct} />
            </div>
          )}

          {/* Product Setup and Approve/Reject are always shown together for
              a pending draft, exactly like Catalog's ProductList already
              does for every other pending product - the backend (price
              required) is the real gate, not this page hiding the button.
              Setting up the product is never combined with approval: this
              is a separate, explicit submit, and Approve remains its own
              separate click. One shared error banner below covers whichever
              action most recently failed, so the same error is never shown
              twice. */}
          {isDraftPending && (
            <>
              <ProductSetupForm
                product={generatedProduct}
                ceiling={opportunity.demandSupportedCeiling?.ceiling ?? null}
                onSave={onSaveProductSetup}
                actionState={actionState}
              />

              <div className="product-form__actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={onApproveProduct}
                  disabled={actionState === 'approving' || actionState === 'rejecting'}
                >
                  {actionState === 'approving' ? 'Approving…' : 'Approve Product'}
                </button>
                <button type="button" onClick={onRejectProduct} disabled={actionState === 'approving' || actionState === 'rejecting'}>
                  {actionState === 'rejecting' ? 'Rejecting…' : 'Reject'}
                </button>
              </div>
              {actionError && (
                <div className="error-banner">
                  <p>{actionError}</p>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* GROWTH FEED — always prominent, never collapsed */}
      <div className="opportunity-detail__loop">
        <h4>Growth Feed</h4>
        <LoopTracker steps={buildGrowthFeedSteps(opportunity)} />
      </div>

      {/* REVENUE IMPACT — ACTIONED only; DISMISSED never implies revenue */}
      {isActioned && (
        <div className="opportunity-detail__section">
          <h4 className="opportunity-detail__section-title">Revenue Impact</h4>
          {opportunity.attribution?.revenue ? (
            <p className="opportunity-card__value">
              {formatMoney(opportunity.attribution.revenue)} from {opportunity.attribution.orderCount} paid order
              {opportunity.attribution.orderCount === 1 ? '' : 's'}
            </p>
          ) : (
            <p>No paid order has been attributed to this action yet.</p>
          )}
          {/* buildOutcomeInterpretation's first line is always the same
              order-count/rejected fact already shown above (via revenue or
              Current State) — only render what comes after it, e.g. "N more
              signals appeared after this action." */}
          {opportunity.outcomeInterpretation?.length > 1 && (
            <ul className="opportunity-detail__outcome">
              {opportunity.outcomeInterpretation.slice(1).map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* DISMISSED — outcome only, never a fabricated action/revenue story */}
      {isDismissed && opportunity.outcomeInterpretation?.length > 0 && (
        <div className="opportunity-detail__section">
          <h4 className="opportunity-detail__section-title">Outcome</h4>
          <ul className="opportunity-detail__outcome">
            {opportunity.outcomeInterpretation.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      <CalculationDisclosure opportunity={opportunity} historicalFit={isActioned ? historicalFit : null} />

      {/* Covers Dismiss/Make-a-product errors (the OPEN action buttons
          below, which this sits directly above). Approve/Reject errors
          render next to those buttons instead (see isDraftPending above) —
          gated here so the same error is never shown in both places. */}
      {actionError && !isDraftPending && (
        <div className="error-banner">
          <p>{actionError}</p>
        </div>
      )}

      {isOpen && (
        <div className="product-form__actions">
          {DRAFT_ELIGIBLE_ACTION_TYPES.includes(opportunity.suggestedAction?.type) && (
            <button
              type="button"
              className="btn-primary"
              onClick={onGenerateDraft}
              disabled={actionState === 'generating' || actionState === 'dismissing'}
            >
              {actionState === 'generating' ? 'Making product…' : 'Make a product with AI'}
            </button>
          )}
          {RESTOCK_ACTION_TYPES.includes(opportunity.suggestedAction?.type) && (
            <Link to="/merchant/catalog" className="btn-primary">
              Go to Catalog
            </Link>
          )}
          <button type="button" onClick={onDismiss} disabled={actionState === 'generating' || actionState === 'dismissing'}>
            {actionState === 'dismissing' ? 'Dismissing…' : 'Dismiss'}
          </button>
        </div>
      )}
    </div>
  )
}

export default OpportunityDetail
