import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, CheckCircle2 } from 'lucide-react'
import { getShopOrders, getShopOrder } from '../lib/api.js'
import { formatMoney } from '../lib/formatMoney.js'

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Simple, everyday wording — no payment-gateway terms, no internal IDs.
function paymentLabel(paymentStatus) {
  return paymentStatus === 'CAPTURED' ? 'Paid' : 'Pending'
}

function statusLabel(status) {
  return status === 'PAID' ? 'Paid' : 'Pending'
}

function OrderRow({ order, onSelect }) {
  return (
    <li className="shop-order-row">
      <button type="button" className="shop-order-row__button" onClick={() => onSelect(order.id)}>
        <div className="shop-order-row__main">
          <span className="shop-order-row__number">Order #{order.orderNumber}</span>
          <span className={`status-badge status-badge--${order.status.toLowerCase()}`}>
            {order.status === 'PAID' && <CheckCircle2 size={12} strokeWidth={2.5} aria-hidden="true" />}
            {statusLabel(order.status)}
          </span>
        </div>
        <div className="shop-order-row__meta">
          <span>{formatDate(order.createdAt)}</span>
          <span className="num-tabular">{formatMoney(order.total)}</span>
          <span>
            {order.itemCount} item{order.itemCount === 1 ? '' : 's'}
          </span>
        </div>
      </button>
    </li>
  )
}

function OrderDetailView({ order, onBack }) {
  return (
    <div className="shop-order-detail">
      <button type="button" className="link-button" onClick={onBack}>
        <ArrowLeft size={14} strokeWidth={2.25} aria-hidden="true" />
        Back to my orders
      </button>

      <h2>Order #{order.orderNumber}</h2>
      <p className="field-hint">{formatDate(order.createdAt)}</p>

      <ul className="shop-order-detail__items">
        {order.items.map((item, index) => (
          <li key={index} className="shop-order-detail__item">
            <span className="shop-order-detail__item-name">{item.productName}</span>
            <span className="field-hint">Qty: {item.quantity}</span>
            <span className="shop-order-detail__item-price num-tabular">{formatMoney(item.lineTotal)}</span>
          </li>
        ))}
      </ul>

      <div className="shop-order-detail__summary">
        <div>
          <p className="field-hint">Total</p>
          <p className="shop-order-detail__total num-tabular">{formatMoney(order.total)}</p>
        </div>
        <div>
          <p className="field-hint">Payment</p>
          <p>{paymentLabel(order.paymentStatus)}</p>
        </div>
        <div>
          <p className="field-hint">Status</p>
          <p>{statusLabel(order.status)}</p>
        </div>
      </div>
    </div>
  )
}

function ShopOrdersPage() {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getShopOrders()
      setOrders(data)
    } catch (err) {
      setError(err.message || 'Could not load your orders')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    Promise.resolve().then(load)
  }, [load])

  async function openOrder(orderId) {
    setSelectedId(orderId)
    setDetailLoading(true)
    setDetailError(null)
    try {
      const data = await getShopOrder(orderId)
      setDetail(data)
    } catch (err) {
      setDetailError(err.message || 'Could not load this order')
    } finally {
      setDetailLoading(false)
    }
  }

  function backToList() {
    setSelectedId(null)
    setDetail(null)
    setDetailError(null)
  }

  if (selectedId) {
    if (detailLoading) return <p>Loading order…</p>
    if (detailError) {
      return (
        <div className="error-banner">
          <p>{detailError}</p>
          <button type="button" onClick={() => openOrder(selectedId)}>
            Retry
          </button>
        </div>
      )
    }
    return <OrderDetailView order={detail} onBack={backToList} />
  }

  return (
    <div className="shop-orders-page">
      <h1>My Orders</h1>

      {loading && <p>Loading your orders…</p>}

      {!loading && error && (
        <div className="error-banner">
          <p>{error}</p>
          <button type="button" onClick={load}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && orders.length === 0 && (
        <p className="empty-state">You have not placed any orders yet.</p>
      )}

      {!loading && !error && orders.length > 0 && (
        <ul className="shop-order-list">
          {orders.map((order) => (
            <OrderRow key={order.id} order={order} onSelect={openOrder} />
          ))}
        </ul>
      )}
    </div>
  )
}

export default ShopOrdersPage
