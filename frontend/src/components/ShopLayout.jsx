import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { Sparkles, Receipt, Store } from 'lucide-react'
import { getMerchants } from '../lib/api.js'

// Phase 8 UX pass: both /shop and /shop/orders must show the SAME two
// primary links ("Shop with AI" and "My Orders") with clear active states,
// so the customer never feels trapped on one screen. "Merchant dashboard"
// stays a quiet secondary link — deliberately not a merchant-management
// nav bleeding into this surface. No sidebar here on purpose: this is the
// lightweight consumer side of the app.
function ShopLayout() {
  const [merchantName, setMerchantName] = useState(null)

  useEffect(() => {
    let cancelled = false
    getMerchants()
      .then((merchants) => {
        if (cancelled) return
        const demo = merchants.find((m) => m.slug === 'demo-merchant') || merchants[0]
        if (demo) setMerchantName(demo.name)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="shop-shell">
      <header className="shop-shell__header">
        <div>
          <p className="shop-shell__brand">SmartCart</p>
          {merchantName && <p className="shop-shell__merchant">{merchantName}</p>}
        </div>

        <nav className="shop-shell__nav" aria-label="Customer navigation">
          <NavLink
            to="/shop"
            end
            className={({ isActive }) => `shop-shell__nav-link ${isActive ? 'shop-shell__nav-link--active' : ''}`}
          >
            <Sparkles size={15} strokeWidth={2} aria-hidden="true" />
            Shop with AI
          </NavLink>
          <NavLink
            to="/shop/orders"
            className={({ isActive }) => `shop-shell__nav-link ${isActive ? 'shop-shell__nav-link--active' : ''}`}
          >
            <Receipt size={15} strokeWidth={2} aria-hidden="true" />
            My Orders
          </NavLink>
          <Link to="/merchant/overview" className="shop-shell__switch-link">
            <Store size={14} strokeWidth={2} aria-hidden="true" />
            Merchant dashboard
          </Link>
        </nav>
      </header>

      <main className="shop-shell__main">
        <Outlet />
      </main>
    </div>
  )
}

export default ShopLayout
