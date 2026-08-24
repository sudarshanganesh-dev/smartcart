import { CheckCircle2 } from 'lucide-react'
import { formatMoney } from '../lib/formatMoney.js'

function formatDateTime(iso) {
  return new Date(iso).toLocaleString()
}

function OrderList({ orders, onSelect }) {
  if (orders.length === 0) {
    return <p className="empty-state">No orders yet. Completed customer checkouts will appear here.</p>
  }

  return (
    <ul className="order-list">
      {orders.map((order) => {
        const isPaid = order.status === 'PAID'
        return (
          <li key={order.id} className="order-row">
            <button type="button" className="order-row__button" onClick={() => onSelect(order.id)}>
              <div className="order-row__main">
                <span className="order-row__number">{order.orderNumber}</span>
                <span className={`status-badge status-badge--${order.status.toLowerCase()}`}>
                  {isPaid && <CheckCircle2 size={12} strokeWidth={2.5} aria-hidden="true" />}
                  {order.status.replace('_', ' ')}
                </span>
              </div>
              <div className="order-row__meta">
                <span className="num-tabular">{formatMoney(order.total)}</span>
                <span>
                  {order.itemCount} item{order.itemCount === 1 ? '' : 's'}
                </span>
                <span>{formatDateTime(order.createdAt)}</span>
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export default OrderList
