import { useOutletContext } from 'react-router-dom'
import OrderWorkspace from './OrderWorkspace.jsx'

function OrdersPage() {
  const { merchant } = useOutletContext()
  return <OrderWorkspace merchant={merchant} />
}

export default OrdersPage
