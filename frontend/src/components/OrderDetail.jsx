import { ArrowLeft, CheckCircle2, Sparkles } from 'lucide-react'
import { formatMoney } from '../lib/formatMoney.js'

function formatDateTime(iso) {
  return new Date(iso).toLocaleString()
}

function OrderDetail({ order, loading, error, onBack, onRetry }) {
  return (
    <div className="order-detail">
      <button type="button" className="link-button" onClick={onBack}>
        <ArrowLeft size={14} strokeWidth={2.25} aria-hidden="true" />
        Back to orders
      </button>

      {loading && <p>Loading order…</p>}

      {!loading && error && (
        <div className="error-banner">
          <p>{error}</p>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && order && (
        <>
          <div className="order-detail__header">
            <h3>{order.orderNumber}</h3>
            <span className={`status-badge status-badge--${order.status.toLowerCase()}`}>
              {order.status === 'PAID' && <CheckCircle2 size={13} strokeWidth={2.5} aria-hidden="true" />}
              {order.status.replace('_', ' ')}
            </span>
          </div>

          {order.paymentStatus === 'CAPTURED' && (
            <p className="order-detail__confirmed">
              <CheckCircle2 size={14} strokeWidth={2.25} aria-hidden="true" />
              Payment received and order confirmed.
            </p>
          )}

          {order.aiAttributed && (
            <div className="order-detail__ai-attribution">
              <p className="order-detail__ai-attribution-title">
                <Sparkles size={13} strokeWidth={2.25} aria-hidden="true" />
                AI-attributed order
              </p>
              <p className="field-hint">This order includes a product created from a SmartCart demand opportunity.</p>
              <ul className="order-detail__ai-attribution-items">
                {order.aiAttributedItems.map((item) => (
                  <li key={item.productId}>
                    {item.productName}
                    <span className="num-tabular"> · {formatMoney(item.unitPrice)} × {item.quantity}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <dl className="order-detail__summary">
            <div>
              <dt>Payment status</dt>
              <dd>{order.paymentStatus}</dd>
            </div>
            <div>
              <dt>Subtotal</dt>
              <dd className="num-tabular">{formatMoney(order.subtotal)}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd className="num-tabular">{formatMoney(order.total)}</dd>
            </div>
            <div>
              <dt>Placed</dt>
              <dd>{formatDateTime(order.createdAt)}</dd>
            </div>
          </dl>

          <h4>Items</h4>
          <ul className="order-detail__items">
            {order.items.map((item, index) => (
              <li key={index} className="order-detail__item">
                <span className="order-detail__item-name">
                  {item.productName}
                  {item.sku && <span className="field-hint"> · SKU: {item.sku}</span>}
                </span>
                <span className="order-detail__item-amounts num-tabular">
                  {item.quantity} × {formatMoney(item.unitPrice)} = {formatMoney(item.lineTotal)}
                </span>
              </li>
            ))}
          </ul>

          <details className="order-detail__payment-details">
            <summary>Payment details</summary>
            <dl className="order-detail__summary order-detail__summary--quiet">
              <div>
                <dt>Razorpay order ID</dt>
                <dd>{order.razorpayOrderId}</dd>
              </div>
              <div>
                <dt>Razorpay payment ID</dt>
                <dd>{order.razorpayPaymentId}</dd>
              </div>
            </dl>
          </details>
        </>
      )}
    </div>
  )
}

export default OrderDetail
