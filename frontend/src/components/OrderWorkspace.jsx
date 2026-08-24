import { useCallback, useEffect, useState } from 'react'
import { getOrders, getOrder } from '../lib/api.js'
import OrderList from './OrderList.jsx'
import OrderDetail from './OrderDetail.jsx'

const TABS = [
  { key: null, label: 'All' },
  { key: 'PAID', label: 'Paid' },
  { key: 'PAYMENT_PENDING', label: 'Payment Pending' },
]

// Phase 5: read-only order visibility. No create/edit/delete anywhere in
// this component — it only ever calls getOrders/getOrder.
function OrderWorkspace({ merchant }) {
  const [activeTab, setActiveTab] = useState(null) // null = "All" (no status filter)
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(null)

  const [selectedOrderId, setSelectedOrderId] = useState(null)
  const [orderDetail, setOrderDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(null)

  const fetchOrders = useCallback(
    async (status) => {
      setLoading(true)
      setListError(null)
      try {
        const data = await getOrders(merchant.id, status ?? undefined)
        setOrders(data)
      } catch (error) {
        setListError(error.message || 'Failed to load orders')
      } finally {
        setLoading(false)
      }
    },
    [merchant.id]
  )

  useEffect(() => {
    Promise.resolve().then(() => fetchOrders(activeTab))
  }, [activeTab, fetchOrders])

  async function openOrder(orderId) {
    setSelectedOrderId(orderId)
    setDetailLoading(true)
    setDetailError(null)
    try {
      const data = await getOrder(merchant.id, orderId)
      setOrderDetail(data)
    } catch (error) {
      setDetailError(error.message || 'Failed to load this order')
    } finally {
      setDetailLoading(false)
    }
  }

  function backToList() {
    setSelectedOrderId(null)
    setOrderDetail(null)
    setDetailError(null)
  }

  if (selectedOrderId) {
    return (
      <OrderDetail
        order={orderDetail}
        loading={detailLoading}
        error={detailError}
        onBack={backToList}
        onRetry={() => openOrder(selectedOrderId)}
      />
    )
  }

  return (
    <div className="order-workspace">
      <div className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.label}
            type="button"
            className={`tab ${activeTab === tab.key ? 'tab--active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading && <p>Loading orders…</p>}

      {!loading && listError && (
        <div className="error-banner">
          <p>{listError}</p>
          <button type="button" onClick={() => fetchOrders(activeTab)}>
            Retry
          </button>
        </div>
      )}

      {!loading && !listError && <OrderList orders={orders} onSelect={openOrder} />}
    </div>
  )
}

export default OrderWorkspace
