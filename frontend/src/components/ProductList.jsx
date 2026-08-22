import { useState } from 'react'
import { ApiError } from '../lib/api.js'

function formatPrice(product) {
  if (product.price === null) return 'Unknown'
  return `${product.currency || ''} ${product.price}`.trim()
}

function describeApiError(error) {
  if (error instanceof ApiError) {
    if (error.body?.missing) {
      return `Cannot approve — missing: ${error.body.missing.join(', ')}`
    }
    if (error.body?.details) {
      return error.body.details.join('; ')
    }
    if (error.status === 409) {
      return "This product's status changed — refreshing the list."
    }
    return error.message
  }
  return 'Something went wrong. Please try again.'
}

function ProductList({ products, onEdit, onApprove, onReject }) {
  const [rowState, setRowState] = useState({})

  async function runAction(product, action, actionFn) {
    setRowState((prev) => ({ ...prev, [product.id]: { acting: action, error: null } }))
    try {
      await actionFn(product)
      setRowState((prev) => ({ ...prev, [product.id]: { acting: null, error: null } }))
    } catch (error) {
      setRowState((prev) => ({
        ...prev,
        [product.id]: { acting: null, error: describeApiError(error) },
      }))
    }
  }

  if (products.length === 0) {
    return <p className="empty-state">No products in this view yet.</p>
  }

  return (
    <ul className="product-list">
      {products.map((product) => {
        const state = rowState[product.id] || {}
        const canReview = product.status === 'PENDING_REVIEW'

        return (
          <li key={product.id} className="product-row">
            <div className="product-row__main">
              <div className="product-row__info">
                <span className="product-row__name">{product.name}</span>
                <span className={`status-badge status-badge--${product.status.toLowerCase()}`}>
                  {product.status.replace('_', ' ')}
                </span>
              </div>
              <div className="product-row__meta">
                <span>{formatPrice(product)}</span>
                <span>{product.category || 'Uncategorized'}</span>
                <span>{product.sku ? `SKU: ${product.sku}` : 'No SKU'}</span>
                <span>
                  {product.availability}
                  {product.stockQuantity !== null ? ` · Qty: ${product.stockQuantity}` : ' · Qty unknown'}
                </span>
              </div>
            </div>

            <div className="product-row__actions">
              <button type="button" onClick={() => onEdit(product)}>
                Edit
              </button>
              <button
                type="button"
                disabled={!canReview || Boolean(state.acting)}
                onClick={() => runAction(product, 'approve', (p) => onApprove(p))}
              >
                {state.acting === 'approve' ? 'Approving…' : 'Approve'}
              </button>
              <button
                type="button"
                disabled={!canReview || Boolean(state.acting)}
                onClick={() => runAction(product, 'reject', (p) => onReject(p))}
              >
                {state.acting === 'reject' ? 'Rejecting…' : 'Reject'}
              </button>
            </div>

            {state.error && <p className="product-row__error">{state.error}</p>}
          </li>
        )
      })}
    </ul>
  )
}

export default ProductList
