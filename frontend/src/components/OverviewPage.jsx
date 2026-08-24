import { useCallback, useEffect, useState } from 'react'
import { useOutletContext, Link } from 'react-router-dom'
import { Package, Clock, Receipt, IndianRupee, Sparkles, CreditCard, ArrowRight } from 'lucide-react'
import { getDashboardSummary } from '../lib/api.js'
import { buildOpportunityLoopSteps } from '../lib/opportunityLoop.js'
import { formatMoney } from '../lib/formatMoney.js'
import LoopTracker from './LoopTracker.jsx'
import DemandPulse from './DemandPulse.jsx'

function StatCard({ label, value, icon: Icon, tabular }) {
  return (
    <div className="overview-stat">
      <span className="overview-stat__icon" aria-hidden="true">
        <Icon size={16} strokeWidth={2} />
      </span>
      <p className="overview-stat__label">{label}</p>
      <p className={`overview-stat__value ${tabular ? 'num-tabular' : ''}`}>{value}</p>
    </div>
  )
}

function OverviewPage() {
  const { merchant } = useOutletContext()
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getDashboardSummary(merchant.id)
      setSummary(data)
    } catch (err) {
      setError(err.message || 'Failed to load dashboard summary')
    } finally {
      setLoading(false)
    }
  }, [merchant.id])

  useEffect(() => {
    Promise.resolve().then(load)
  }, [load])

  if (loading) return <p>Loading overview…</p>

  if (error) {
    return (
      <div className="error-banner">
        <p>{error}</p>
        <button type="button" onClick={load}>
          Retry
        </button>
      </div>
    )
  }

  const opportunity = summary.highlightedOpportunity

  return (
    <div className="overview-page">
      <div className="page-header">
        <h1>Overview</h1>
        <p className="field-hint">{merchant.name}</p>
      </div>

      <div className="overview-stats">
        <StatCard label="Products live" value={summary.products.approved} icon={Package} />
        <StatCard label="Waiting for review" value={summary.products.pendingReview} icon={Clock} />
        <StatCard label="Orders paid" value={summary.orders.paid} icon={Receipt} />
        <StatCard label="Money earned" value={formatMoney(summary.orders.revenue)} icon={IndianRupee} tabular />
        <StatCard label="New chances" value={summary.opportunities.open} icon={Sparkles} />
      </div>

      {opportunity ? (
        <div className="ai-growth-card">
          <p className="ai-growth-card__kicker">
            <Sparkles size={13} strokeWidth={2.25} aria-hidden="true" />
            AI Growth
          </p>
          <h2>{opportunity.generatedProduct ? opportunity.generatedProduct.name : opportunity.label || 'Revenue opportunity'}</h2>
          <p className="ai-growth-card__subtitle">{opportunity.whyExplanation}</p>

          <LoopTracker steps={buildOpportunityLoopSteps(opportunity)} />

          <Link to="/merchant/opportunities" className="ai-growth-card__link">
            See full details
            <ArrowRight size={14} strokeWidth={2.25} aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <div className="ai-growth-card ai-growth-card--empty">
          <p className="ai-growth-card__kicker">
            <Sparkles size={13} strokeWidth={2.25} aria-hidden="true" />
            AI Growth
          </p>
          <p>No chances yet. AI will find them as customers shop.</p>
        </div>
      )}

      <DemandPulse signals={summary.topDemandSignals || []} />

      {summary.recentActivity.length > 0 && (
        <div className="overview-activity">
          <h3>Recent activity</h3>
          <ul className="overview-activity__list">
            {summary.recentActivity.map((item, index) => {
              const isPayment = item.type === 'ORDER_PAID'
              return (
                <li key={index} className="overview-activity__item">
                  <span className={`overview-activity__icon ${isPayment ? 'overview-activity__icon--payment' : ''}`} aria-hidden="true">
                    {isPayment ? <CreditCard size={14} strokeWidth={2} /> : <Sparkles size={14} strokeWidth={2} />}
                  </span>
                  <span className="overview-activity__text">
                    {isPayment ? `Payment received — ${item.label}` : `AI made a product — ${item.label}`}
                    {item.amount && <span className="num-tabular"> · {formatMoney(item.amount)}</span>}
                  </span>
                  <span className="field-hint overview-activity__time">{new Date(item.at).toLocaleString()}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

export default OverviewPage
