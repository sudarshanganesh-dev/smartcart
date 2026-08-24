import { Link } from 'react-router-dom'
import { CheckCircle2, ArrowRight } from 'lucide-react'

// Phase 8: a dedicated visual treatment for the payment-confirmation
// message, distinct from an ordinary chat bubble — a true success panel,
// not just another message. The text itself is still entirely
// backend-authored (see CustomerChat.jsx) — this component only changes
// how it's presented, never what it says, and only links to a page that
// already exists (/shop/orders) rather than inventing any new data.
function PaymentSuccessCard({ text }) {
  return (
    <div className="payment-success-card">
      <span className="payment-success-card__icon" aria-hidden="true">
        <CheckCircle2 size={22} strokeWidth={2.25} />
      </span>
      <div className="payment-success-card__body">
        <p className="payment-success-card__badge">Payment successful</p>
        <p className="payment-success-card__text">{text}</p>
        <Link to="/shop/orders" className="payment-success-card__link">
          View My Orders
          <ArrowRight size={14} strokeWidth={2.25} aria-hidden="true" />
        </Link>
      </div>
    </div>
  )
}

export default PaymentSuccessCard
