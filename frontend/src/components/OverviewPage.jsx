import { useCallback, useEffect, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import {
  Sparkles,
  Package,
  Clock,
  Receipt,
  IndianRupee,
  ShoppingCart,
  Bot,
  Search,
  CheckCircle2,
  XCircle,
  HelpCircle,
  PackageCheck,
  PackageX,
  CreditCard,
  ArrowRight,
} from 'lucide-react'
import { getDashboardSummary } from '../lib/api.js'
import { formatMoney } from '../lib/formatMoney.js'
import AttentionQueue from './AttentionQueue.jsx'
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

// Plain percentage of two real numbers - never a target, forecast, or ROI.
// Safe against a zero (or not-yet-loaded) total store revenue.
function computeAiRevenueSharePercent(verifiedAiRevenue, totalStoreRevenue) {
  const total = Number(totalStoreRevenue)
  const verified = Number(verifiedAiRevenue)
  if (!total || total <= 0 || !verified) return 0
  return Math.round((verified / total) * 1000) / 10
}

// Grammatically correct from the real total/actioned counts only - never
// assumes "both" unless there are genuinely exactly two, and never implies
// SmartCart found nothing just because there are 0 OPEN opportunities right
// now.
function buildDemandEmptyMessage({ total, actioned }) {
  if (total === 0) {
    return 'No growth opportunities identified yet.'
  }
  if (actioned === total) {
    const subject =
      total === 1 ? 'The identified opportunity has' : total === 2 ? 'Both identified opportunities have' : `All ${total} identified opportunities have`
    return `No open demand signals right now. ${subject} already been actioned.`
  }
  const opportunityWord = total === 1 ? 'opportunity' : 'opportunities'
  return `No open demand signals right now. ${actioned} of ${total} identified ${opportunityWord} have been actioned.`
}

// Feature 3 - Merchant AI Commerce Control Center. Full page: SmartCart
// Brief, Business Snapshot, AI Revenue Impact, Demand Intelligence, Needs
// Your Attention, Catalog Health, Recent Activity. Every section reads
// directly from the dashboard-summary DTO - nothing rendered here is
// computed or fabricated on the frontend beyond plain display formatting.
// Commerce System Status (Database/Payments/Buyer Agent/Growth Agent
// config-presence checks) was deliberately removed from this page after
// review - it's developer/infrastructure information, not merchant business
// intelligence. The backend DTO still returns systemStatus (dashboardService
// .js was intentionally left alone; this was a UI-only decision), so it can
// come back on an internal/ops surface later without any backend rework.
// The old standalone AI Growth card is deliberately not restored - its
// closed-loop LoopTracker was assessed for Demand Intelligence but left out
// since it would only re-show the same ₹95.00/1-order facts AI Revenue
// Impact already states plainly, and there is currently no OPEN opportunity
// for it to usefully feature instead.
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

  return (
    <div className="overview-page">
      <div className="page-header control-center__header">
        <h1>Merchant AI Commerce Control Center</h1>
        <p className="field-hint">Monitor demand, supervise AI actions, and track the revenue SmartCart creates.</p>
      </div>

      <div className="smartcart-brief">
        <p className="smartcart-brief__kicker">
          <Sparkles size={13} strokeWidth={2.25} aria-hidden="true" />
          SmartCart Brief
        </p>
        <p className="smartcart-brief__text">{summary.smartCartBrief}</p>

        <div className="smartcart-brief__metrics">
          <div className="smartcart-brief__metric">
            <span className="smartcart-brief__metric-value num-tabular">{summary.opportunities.total}</span>
            <span className="smartcart-brief__metric-label">Growth opportunities</span>
          </div>
          <div className="smartcart-brief__metric">
            <span className="smartcart-brief__metric-value num-tabular">{summary.aiRevenueImpact.verifiedAiOrderCount}</span>
            <span className="smartcart-brief__metric-label">Verified AI order{summary.aiRevenueImpact.verifiedAiOrderCount === 1 ? '' : 's'}</span>
          </div>
          <div className="smartcart-brief__metric">
            <span className="smartcart-brief__metric-value num-tabular">{formatMoney(summary.aiRevenueImpact.verifiedAiRevenue)}</span>
            <span className="smartcart-brief__metric-label">Verified AI revenue</span>
          </div>
        </div>
      </div>

      <div className="control-center__section">
        <h2>Business Snapshot</h2>
        <div className="overview-stats">
          <StatCard label="Products live" value={summary.products.approved} icon={Package} />
          <StatCard label="Waiting for review" value={summary.products.pendingReview} icon={Clock} />
          <StatCard label="Orders paid" value={summary.orders.paid} icon={Receipt} />
          <StatCard label="Total store revenue" value={formatMoney(summary.orders.revenue)} icon={IndianRupee} tabular />
          <StatCard label="Open opportunities" value={summary.opportunities.open} icon={Sparkles} />
        </div>
      </div>

      <div className="control-center__section">
        <div className="control-center__section-intro">
          <h2>AI Revenue Impact</h2>
          <p className="field-hint">Revenue SmartCart can prove it created, versus your total store revenue.</p>
        </div>
        <div className="ai-revenue-card">
          <div className="ai-revenue-card__compare">
            <div className="ai-revenue-card__figure">
              <span className="ai-revenue-card__figure-label">Total store revenue</span>
              <span className="ai-revenue-card__figure-value num-tabular">{formatMoney(summary.aiRevenueImpact.totalStoreRevenue)}</span>
            </div>
            <div className="ai-revenue-card__figure ai-revenue-card__figure--ai">
              <span className="ai-revenue-card__figure-label">Verified AI revenue</span>
              <span className="ai-revenue-card__figure-value num-tabular">{formatMoney(summary.aiRevenueImpact.verifiedAiRevenue)}</span>
            </div>
          </div>

          <div className="ai-revenue-card__bar" aria-hidden="true">
            <div
              className="ai-revenue-card__bar-fill"
              style={{ width: `${computeAiRevenueSharePercent(summary.aiRevenueImpact.verifiedAiRevenue, summary.aiRevenueImpact.totalStoreRevenue)}%` }}
            />
          </div>
          <p className="field-hint">
            {computeAiRevenueSharePercent(summary.aiRevenueImpact.verifiedAiRevenue, summary.aiRevenueImpact.totalStoreRevenue)}% of total store
            revenue is verified AI-attributed.
          </p>

          <div className="overview-stats">
            <StatCard label="Verified AI orders" value={summary.aiRevenueImpact.verifiedAiOrderCount} icon={ShoppingCart} />
            <StatCard label="AI-generated products" value={summary.aiRevenueImpact.aiProductCount} icon={Bot} />
          </div>
        </div>
      </div>

      <div className="control-center__section">
        <h2>Demand Intelligence</h2>
        <div className="overview-stats">
          <StatCard label="Growth opportunities" value={summary.opportunities.total} icon={Sparkles} />
          <StatCard label="Open" value={summary.opportunities.open} icon={Search} />
          <StatCard label="Actioned" value={summary.opportunities.actioned} icon={CheckCircle2} />
        </div>
        <DemandPulse
          signals={summary.topDemandSignals}
          emptyMessage={buildDemandEmptyMessage({ total: summary.opportunities.total, actioned: summary.opportunities.actioned })}
        />
      </div>

      <div className="control-center__section">
        <div className="control-center__section-intro">
          <h2>Needs Your Attention</h2>
          <p className="field-hint">Items that need a merchant decision or catalog action.</p>
        </div>
        <AttentionQueue items={summary.attentionQueue} />
      </div>

      <div className="control-center__section">
        <h2>Catalog Health</h2>

        <div className="catalog-health__group">
          <h4>By status</h4>
          <div className="overview-stats">
            <StatCard label="Total products" value={summary.catalogHealth.total} icon={Package} />
            <StatCard label="Approved" value={summary.catalogHealth.approved} icon={CheckCircle2} />
            <StatCard label="Pending" value={summary.catalogHealth.pending} icon={Clock} />
            <StatCard label="Rejected" value={summary.catalogHealth.rejected} icon={XCircle} />
          </div>
        </div>

        <div className="catalog-health__group">
          <h4>By availability</h4>
          <div className="overview-stats">
            <StatCard label="In stock" value={summary.catalogHealth.inStock} icon={PackageCheck} />
            <StatCard label="Out of stock" value={summary.catalogHealth.outOfStock} icon={PackageX} />
            <StatCard label="Unknown availability" value={summary.catalogHealth.unknown} icon={HelpCircle} />
          </div>
        </div>

        <Link to="/merchant/catalog" className="attention-item__action">
          Open Catalog
          <ArrowRight size={13} strokeWidth={2.25} aria-hidden="true" />
        </Link>
      </div>

      <div className="control-center__section">
        <h2>Recent Activity</h2>
        {summary.recentActivity.length === 0 ? (
          <p className="empty-state">No recent activity yet.</p>
        ) : (
          <ul className="overview-activity__list">
            {summary.recentActivity.map((item) => {
              const isPayment = item.type === 'ORDER_PAID'
              return (
                <li key={`${item.type}:${item.at}`} className="overview-activity__item">
                  <span className={`overview-activity__icon ${isPayment ? 'overview-activity__icon--payment' : ''}`} aria-hidden="true">
                    {isPayment ? <CreditCard size={14} strokeWidth={2} /> : <Sparkles size={14} strokeWidth={2} />}
                  </span>
                  <span className="overview-activity__text">
                    {isPayment ? `Payment received - ${item.label}` : `AI made a product - ${item.label}`}
                    {item.amount && <span className="num-tabular"> · {formatMoney(item.amount)}</span>}
                  </span>
                  <span className="field-hint overview-activity__time">{new Date(item.at).toLocaleString()}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

export default OverviewPage
