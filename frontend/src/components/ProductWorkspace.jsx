import { useCallback, useEffect, useState } from 'react'
import { getProducts, createProduct, updateProduct, approveProduct, rejectProduct, deleteProduct } from '../lib/api.js'
import ProductForm from './ProductForm.jsx'
import ProductList from './ProductList.jsx'

const TABS = [
  { key: 'PENDING_REVIEW', label: 'Pending Review' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
]

function ProductWorkspace({ merchant, onBack }) {
  const [activeTab, setActiveTab] = useState('PENDING_REVIEW')
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(null)
  const [formMode, setFormMode] = useState(null) // null | 'create' | product object
  const [successMessage, setSuccessMessage] = useState(null)

  // `silent` skips the loading-state swap so <ProductList> stays mounted through the
  // refetch — approve/reject/delete rely on this to keep their per-row error visible
  // instead of it being wiped by an unmount/remount when the list briefly disappears.
  const fetchProducts = useCallback(async (status, { silent = false } = {}) => {
    if (!silent) setLoading(true)
    setListError(null)
    try {
      const data = await getProducts(merchant.id, status)
      setProducts(data)
    } catch (error) {
      setListError(error.message || 'Failed to load products')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [merchant.id])

  useEffect(() => {
    Promise.resolve().then(() => fetchProducts(activeTab))
  }, [activeTab, fetchProducts])

  function selectTab(tabKey) {
    setSuccessMessage(null)
    setActiveTab(tabKey)
  }

  async function handleCreate(payload) {
    const created = await createProduct(merchant.id, payload)
    setFormMode(null)
    setSuccessMessage('Product created.')
    setActiveTab(created.status)
    if (created.status === activeTab) {
      await fetchProducts(activeTab)
    }
  }

  async function handleUpdate(payload) {
    const updated = await updateProduct(merchant.id, formMode.id, payload)
    setFormMode(null)
    setSuccessMessage('Product updated.')
    setActiveTab(updated.status)
    if (updated.status === activeTab) {
      await fetchProducts(activeTab)
    }
  }

  async function handleApprove(product) {
    try {
      await approveProduct(merchant.id, product.id)
    } finally {
      await fetchProducts(activeTab, { silent: true })
    }
  }

  async function handleReject(product) {
    try {
      await rejectProduct(merchant.id, product.id)
    } finally {
      await fetchProducts(activeTab, { silent: true })
    }
  }

  async function handleDelete(product) {
    try {
      await deleteProduct(merchant.id, product.id)
      setSuccessMessage('Product deleted.')
    } finally {
      await fetchProducts(activeTab, { silent: true })
    }
  }

  return (
    <div className="product-workspace">
      <div className="product-workspace__header">
        <button type="button" className="link-button" onClick={onBack}>
          ← Back
        </button>
        <h2>{merchant.name} — Products</h2>
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            setSuccessMessage(null)
            setFormMode('create')
          }}
        >
          + Add product
        </button>
      </div>

      {successMessage && <p className="success-banner">{successMessage}</p>}

      {formMode && (
        <ProductForm
          product={formMode === 'create' ? null : formMode}
          onSubmit={formMode === 'create' ? handleCreate : handleUpdate}
          onCancel={() => setFormMode(null)}
        />
      )}

      <div className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`tab ${activeTab === tab.key ? 'tab--active' : ''}`}
            onClick={() => selectTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading && <p>Loading products…</p>}

      {!loading && listError && (
        <div className="error-banner">
          <p>{listError}</p>
          <button type="button" onClick={() => fetchProducts(activeTab)}>
            Retry
          </button>
        </div>
      )}

      {!loading && !listError && (
        <ProductList
          products={products}
          onEdit={(product) => {
            setSuccessMessage(null)
            setFormMode(product)
          }}
          onApprove={handleApprove}
          onReject={handleReject}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}

export default ProductWorkspace
