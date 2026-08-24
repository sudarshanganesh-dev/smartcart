import { useEffect, useState } from 'react'
import { NavLink, Outlet, Link } from 'react-router-dom'
import { LayoutDashboard, Package, Receipt, Sparkles, ShoppingBag, ArrowLeftRight } from 'lucide-react'
import { getMerchants } from '../lib/api.js'
import ConnectionStatus from './ConnectionStatus.jsx'

const NAV_ITEMS = [
  { to: '/merchant/overview', label: 'Overview', icon: LayoutDashboard },
  { to: '/merchant/catalog', label: 'Catalog', icon: Package },
  { to: '/merchant/orders', label: 'Orders', icon: Receipt },
  { to: '/merchant/opportunities', label: 'Opportunities', icon: Sparkles },
]

// Phase 8: the Merchant surface's own shell — sidebar + content outlet.
// Owns the one merchant-fetch every /merchant/* page needs (moved here from
// the old App.jsx), so it runs once per visit to the Merchant surface, not
// once for the whole app.
function MerchantLayout() {
  const [merchant, setMerchant] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadMerchant()
  }, [])

  async function loadMerchant() {
    setLoading(true)
    setError(null)
    try {
      const merchants = await getMerchants()
      const demo = merchants.find((m) => m.slug === 'demo-merchant') || merchants[0]
      if (!demo) {
        setError('No merchant found. Seed a demo merchant on the backend first.')
      } else {
        setMerchant(demo)
      }
    } catch {
      setError('Could not load merchant from the backend.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="merchant-shell">
      <aside className="merchant-shell__sidebar">
        <Link to="/" className="merchant-shell__brand">
          SmartCart
        </Link>

        <nav className="merchant-shell__nav" aria-label="Merchant navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `merchant-shell__nav-link ${isActive ? 'merchant-shell__nav-link--active' : ''}`}
              >
                <Icon size={16} strokeWidth={2} aria-hidden="true" />
                {item.label}
              </NavLink>
            )
          })}
        </nav>

        <div className="merchant-shell__footer">
          {merchant && <p className="merchant-shell__merchant-name">{merchant.name}</p>}
          <ConnectionStatus />
          <Link to="/shop" className="merchant-shell__switch-link">
            <ShoppingBag size={14} strokeWidth={2} aria-hidden="true" />
            Open customer store
          </Link>
          <Link to="/" className="merchant-shell__switch-link">
            <ArrowLeftRight size={14} strokeWidth={2} aria-hidden="true" />
            Switch role
          </Link>
        </div>
      </aside>

      <main className="merchant-shell__main">
        {loading && <p>Loading merchant…</p>}

        {!loading && error && (
          <div className="error-banner">
            <p>{error}</p>
            <button type="button" onClick={loadMerchant}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && merchant && <Outlet context={{ merchant }} />}
      </main>
    </div>
  )
}

export default MerchantLayout
