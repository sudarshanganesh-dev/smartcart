import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './App.css'
import RoleSelector from './components/RoleSelector.jsx'
import MerchantLayout from './components/MerchantLayout.jsx'
import ShopLayout from './components/ShopLayout.jsx'
import OverviewPage from './components/OverviewPage.jsx'
import CatalogPage from './components/CatalogPage.jsx'
import OrdersPage from './components/OrdersPage.jsx'
import OpportunitiesPage from './components/OpportunitiesPage.jsx'
import CustomerChat from './components/CustomerChat.jsx'
import ShopOrdersPage from './components/ShopOrdersPage.jsx'

// Phase 8: the app is now a real router with two structurally separate
// surfaces — /merchant/* (dashboard) and /shop (AI storefront) — rather
// than adjacent tabs inside one page. "/" is the demo's intended starting
// point: a persona selector, not authentication.
function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RoleSelector />} />

        <Route path="/merchant" element={<MerchantLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="catalog" element={<CatalogPage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="opportunities" element={<OpportunitiesPage />} />
        </Route>

        <Route path="/shop" element={<ShopLayout />}>
          <Route index element={<CustomerChat />} />
          <Route path="orders" element={<ShopOrdersPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
