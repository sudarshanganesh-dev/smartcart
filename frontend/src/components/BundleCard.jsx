import { useState } from 'react'
import { Check, ChevronDown, Sparkles, Cpu, Target, Search, Filter, Layers, ShieldCheck, ShoppingBag, AlertTriangle, BadgeCheck } from 'lucide-react'
import { formatMoney } from '../lib/formatMoney.js'

// Internal name only — never shown to the customer. This is SmartCart's
// "here's what I'd choose for your goal" plan card: the customer told
// SmartCart what they're trying to accomplish, and every product/price/
// total here is backend-verified, never AI-invented (see bundleTools.js).

function describeAddError(error) {
  const code = error?.body?.error
  switch (code) {
    case 'NO_ACTIVE_PLAN':
      return { message: 'This plan is no longer active — ask SmartCart for a new one.', blockers: null }
    case 'UNKNOWN_CONVERSATION':
      return { message: 'This conversation has expired — start a new chat and ask again.', blockers: null }
    case 'PLAN_ITEM_INVALID':
      return { message: 'Something in this plan changed, so it could not be added.', blockers: error.body.blockers || null }
    default:
      return { message: 'Could not add this plan to your cart. Please try again.', blockers: null }
  }
}

function capitalize(word) {
  return typeof word === 'string' && word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word
}

// Per-item verified-fact detail — folded into the Decision Engine's VERIFY
// stage (this replaces the old standalone "Why these?" toggle with one
// premium expandable experience instead of two separate buttons).
function ItemFactGroups({ items }) {
  const groups = items.filter((item) => item.why && item.why.length > 0)
  if (groups.length === 0) return null

  return (
    <div className="decision-engine__item-facts">
      {groups.map((item) => (
        <div key={item.productId} className="plan-card__why-group">
          <p className="plan-card__why-group-title">{item.name}</p>
          <ul>
            {item.why.map((fact) => (
              <li key={fact.id} className="why-this__item">
                <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                {fact.label}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

// The SmartCart Decision Engine — a compact, collapsed-by-default pipeline
// view of exactly how this plan was built. Every number here comes straight
// from bundle.trace (deterministic, server-computed — see bundleTools.js /
// planOptimizer.js); nothing here is Gemini-supplied. SEARCH/FILTER/OPTIMIZE
// only mean anything when the deterministic optimizer's own pick is what's
// shown (selectionMethod === 'optimizer') — trace deliberately sends `null`
// for those fields otherwise, so this renders a different, equally honest
// pipeline (AI PROPOSED / VALIDATE) rather than ever showing a fake zero.
function DecisionEngine({ bundle }) {
  const [open, setOpen] = useState(false)
  const trace = bundle.trace
  if (!trace) return null

  const isOptimized = trace.selectionMethod === 'optimizer'
  const hasFilterNotes = isOptimized && (trace.overBudgetCount > 0 || trace.unavailableCount > 0)

  return (
    <div className="decision-engine">
      <button type="button" className="decision-engine__toggle" onClick={() => setOpen((v) => !v)}>
        <Cpu size={13} strokeWidth={2.25} aria-hidden="true" />
        SmartCart Decision Engine
        <ChevronDown
          size={13}
          strokeWidth={2.25}
          className={`why-this__chevron ${open ? 'why-this__chevron--open' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="decision-engine__stages">
          <div className="decision-engine__stage">
            <span className="decision-engine__stage-icon" aria-hidden="true">
              <Target size={14} strokeWidth={2} />
            </span>
            <div className="decision-engine__stage-body">
              <p className="decision-engine__stage-label">AI understood</p>
              <p className="decision-engine__stage-detail">
                {bundle.planLabel}
                {bundle.preferences.length > 0 && ` · ${bundle.preferences.map(capitalize).join(' · ')}`}
              </p>
              {(bundle.maxBudget != null || bundle.groupSize != null) && (
                <p className="field-hint">
                  {bundle.maxBudget != null && `Maximum ${formatMoney(bundle.maxBudget)}`}
                  {bundle.maxBudget != null && bundle.groupSize != null && ' · '}
                  {/* Context only — never a claim that the plan serves/covers this many people. */}
                  {bundle.groupSize != null && `For ${bundle.groupSize} people`}
                </p>
              )}
            </div>
          </div>

          {isOptimized ? (
            <>
              <div className="decision-engine__stage">
                <span className="decision-engine__stage-icon" aria-hidden="true">
                  <Search size={14} strokeWidth={2} />
                </span>
                <div className="decision-engine__stage-body">
                  <p className="decision-engine__stage-label">Search</p>
                  <p className="decision-engine__stage-detail">
                    SmartCart explored {trace.checkedCount} unique approved product{trace.checkedCount === 1 ? '' : 's'}
                  </p>
                </div>
              </div>

              <div className="decision-engine__stage">
                <span className="decision-engine__stage-icon" aria-hidden="true">
                  <Filter size={14} strokeWidth={2} />
                </span>
                <div className="decision-engine__stage-body">
                  <p className="decision-engine__stage-label">Filter</p>
                  <p className="decision-engine__stage-detail">
                    {trace.eligibleCount} valid choice{trace.eligibleCount === 1 ? '' : 's'}
                  </p>
                  {hasFilterNotes && (
                    <p className="field-hint">
                      {[
                        trace.overBudgetCount > 0 ? `${trace.overBudgetCount} over budget` : null,
                        trace.unavailableCount > 0 ? `${trace.unavailableCount} unavailable` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </div>
              </div>

              <div className="decision-engine__stage">
                <span className="decision-engine__stage-icon" aria-hidden="true">
                  <Layers size={14} strokeWidth={2} />
                </span>
                <div className="decision-engine__stage-body">
                  <p className="decision-engine__stage-label">Optimize</p>
                  <p className="decision-engine__stage-detail">
                    SmartCart checked {trace.evaluatedCount} possible plan{trace.evaluatedCount === 1 ? '' : 's'}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="decision-engine__stage">
                <span className="decision-engine__stage-icon" aria-hidden="true">
                  <Sparkles size={14} strokeWidth={2} />
                </span>
                <div className="decision-engine__stage-body">
                  <p className="decision-engine__stage-label">AI proposed</p>
                  <p className="decision-engine__stage-detail">
                    {trace.validatedItemCount} product{trace.validatedItemCount === 1 ? '' : 's'} selected
                  </p>
                </div>
              </div>

              <div className="decision-engine__stage">
                <span className="decision-engine__stage-icon" aria-hidden="true">
                  <BadgeCheck size={14} strokeWidth={2} />
                </span>
                <div className="decision-engine__stage-body">
                  <p className="decision-engine__stage-label">Validate</p>
                  <p className="decision-engine__stage-detail">
                    {trace.validatedItemCount} product{trace.validatedItemCount === 1 ? '' : 's'} re-checked against live catalog data
                  </p>
                </div>
              </div>
            </>
          )}

          <div className="decision-engine__stage">
            <span className="decision-engine__stage-icon" aria-hidden="true">
              <Check size={14} strokeWidth={2.5} />
            </span>
            <div className="decision-engine__stage-body">
              <p className="decision-engine__stage-label">{isOptimized ? 'Best verified plan' : 'Plan'}</p>
              <p className="decision-engine__stage-detail num-tabular">
                {bundle.itemCount} product{bundle.itemCount === 1 ? '' : 's'} · {formatMoney(bundle.subtotal)}
                {bundle.maxBudget != null && ` / ${formatMoney(bundle.maxBudget)}`}
              </p>
              {bundle.remaining != null && (
                <p className="field-hint num-tabular">{formatMoney(bundle.remaining)} remaining</p>
              )}
            </div>
          </div>

          <div className="decision-engine__stage">
            <span className="decision-engine__stage-icon" aria-hidden="true">
              <ShieldCheck size={14} strokeWidth={2} />
            </span>
            <div className="decision-engine__stage-body">
              <p className="decision-engine__stage-label">Verify</p>
              {trace.preferencesTotal > 0 && (
                <p className="decision-engine__stage-detail">
                  Matched {trace.matchedPreferences.length} of {trace.preferencesTotal} preference
                  {trace.preferencesTotal === 1 ? '' : 's'}
                </p>
              )}
              <ul className="plan-card__checks decision-engine__checks">
                {bundle.why?.map((fact) => (
                  <li key={fact.id}>
                    <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                    {fact.label}
                  </li>
                ))}
                {trace.unverifiedPreferences.map((preference) => (
                  <li key={`unverified-${preference}`} className="decision-engine__unverified">
                    <AlertTriangle size={13} strokeWidth={2.25} aria-hidden="true" />
                    {capitalize(preference)} could not be verified
                  </li>
                ))}
              </ul>
              <ItemFactGroups items={bundle.items} />
            </div>
          </div>

          <div className="decision-engine__stage decision-engine__stage--last">
            <span className="decision-engine__stage-icon" aria-hidden="true">
              <ShoppingBag size={14} strokeWidth={2} />
            </span>
            <div className="decision-engine__stage-body">
              <p className="decision-engine__stage-label">Ready to buy</p>
              <p className="decision-engine__stage-detail">
                {bundle.itemCount} checked product{bundle.itemCount === 1 ? '' : 's'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function BundleCard({ bundle, onAddAll }) {
  const [state, setState] = useState({ status: 'idle', message: null, blockers: null })

  async function handleAddAll() {
    setState({ status: 'adding', message: null, blockers: null })
    try {
      await onAddAll()
      setState({ status: 'added', message: null, blockers: null })
    } catch (error) {
      const { message, blockers } = describeAddError(error)
      setState({ status: 'error', message, blockers })
    }
  }

  return (
    <div className="plan-card">
      <div className="plan-card__header">
        <p className="plan-card__kicker">
          <Sparkles size={13} strokeWidth={2.25} aria-hidden="true" />
          Picked for your goal
        </p>
        <h3 className="plan-card__title">{bundle.planLabel}</h3>
      </div>

      <ul className="plan-card__items">
        {bundle.items.map((item) => (
          <li key={item.productId} className="plan-card__item">
            <span className="plan-card__item-name">
              {item.name}
              {item.quantity > 1 && <span className="field-hint"> × {item.quantity}</span>}
            </span>
            <span className="plan-card__item-price num-tabular">{formatMoney(item.lineTotal)}</span>
          </li>
        ))}
      </ul>

      <div className="plan-card__totals">
        <div className="plan-card__totals-row plan-card__totals-row--total">
          <span>Total</span>
          <span className="num-tabular">{formatMoney(bundle.subtotal)}</span>
        </div>
        {bundle.maxBudget != null && (
          <div className="plan-card__totals-row">
            <span>Budget</span>
            <span className="num-tabular">{formatMoney(bundle.maxBudget)}</span>
          </div>
        )}
        {bundle.remaining != null && (
          <div className="plan-card__totals-row plan-card__totals-row--remaining">
            <span>Remaining</span>
            <span className="num-tabular">{formatMoney(bundle.remaining)}</span>
          </div>
        )}
      </div>

      {bundle.why?.length > 0 && (
        <ul className="plan-card__checks">
          {bundle.why.map((fact) => (
            <li key={fact.id}>
              <Check size={13} strokeWidth={2.5} aria-hidden="true" />
              {fact.label}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="btn-primary plan-card__add-button"
        onClick={handleAddAll}
        disabled={state.status === 'adding' || state.status === 'added'}
      >
        {state.status === 'adding' && 'Adding…'}
        {state.status === 'added' && 'Added to cart'}
        {(state.status === 'idle' || state.status === 'error') && 'Add all to cart'}
      </button>

      {state.status === 'error' && (
        <div className="plan-card__error">
          <p>{state.message}</p>
          {state.blockers && state.blockers.length > 0 && (
            <ul>
              {state.blockers.map((blocker) => (
                <li key={blocker.productId}>
                  {blocker.name}: {blocker.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <DecisionEngine bundle={bundle} />
    </div>
  )
}

export default BundleCard
