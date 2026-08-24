import { Link } from 'react-router-dom'
import { Store, ShoppingBag, ArrowRight } from 'lucide-react'

// Phase 8: the intended demo starting point. A persona selector only — no
// credentials, no session, nothing sent to the backend. Choosing a role is
// just client-side navigation to a structurally separate surface.
//
// Both cards below share EXACTLY the same internal structure (icon / title
// / description slot / action link) so future text edits can never break
// alignment — see .role-selector__card-description's reserved min-height
// and .role-selector__card-cta's margin-top: auto in App.css.
function RoleSelector() {
  return (
    <div className="role-selector">
      <div className="role-selector__intro">
        <p className="role-selector__brand">SmartCart</p>
        <h1 className="role-selector__title">AI commerce that learns what customers want.</h1>
        <p className="role-selector__subtitle">
          AI helps merchants find demand, create new products, and turn missed sales into revenue.
        </p>
      </div>

      <div className="role-selector__cards">
        <Link to="/merchant/overview" className="role-selector__card">
          <span className="role-selector__card-icon" aria-hidden="true">
            <Store size={22} strokeWidth={2} />
          </span>
          <h2 className="role-selector__card-title">Merchant</h2>
          <p className="role-selector__card-description">Manage products, orders, and AI growth.</p>
          <span className="role-selector__card-cta">
            Enter Merchant Dashboard
            <ArrowRight size={15} strokeWidth={2.25} />
          </span>
        </Link>

        <Link to="/shop" className="role-selector__card">
          <span className="role-selector__card-icon" aria-hidden="true">
            <ShoppingBag size={22} strokeWidth={2} />
          </span>
          <h2 className="role-selector__card-title">Customer</h2>
          <p className="role-selector__card-description">Find and buy products with an AI shopping assistant.</p>
          <span className="role-selector__card-cta">
            Start Shopping
            <ArrowRight size={15} strokeWidth={2.25} />
          </span>
        </Link>
      </div>
    </div>
  )
}

export default RoleSelector
