import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { ApiError } from '../lib/api.js'
import { formatMoney } from '../lib/formatMoney.js'
import { describePriceViolation } from '../lib/pricePolicyMessages.js'

const SOURCE_LABELS = {
  MANUAL: 'Manual',
  FILE_UPLOAD: 'File Upload',
  CRAWL: 'Website Crawl',
  AI_OPPORTUNITY: 'AI Generated',
}

const MISSING_FIELD_MESSAGES = {
  name: 'Name is missing',
  price: 'Price is missing',
  currency: 'Currency is missing',
  category: 'Category is missing',
  availability: 'Availability must be selected',
  sku: 'SKU is invalid',
  stockQuantity: 'Stock quantity is invalid',
}

function formatPrice(product) {
  if (product.price === null) return 'Unknown'
  return formatMoney(product.price)
}

// Prefers the backend's own structured error data over any generic message,
// only falling back to a plain "Something went wrong" when nothing structured
// came back at all (e.g. a real network failure, not a backend response).
// `price` is the product's own current price (already known from the row
// being acted on) — passed through so the price-policy message can name the
// exact number that was rejected, via the shared describePriceViolation.
function describeApiError(error, price) {
  if (!(error instanceof ApiError)) {
    return { heading: 'Something went wrong. Please try again.', items: [] }
  }

  const body = error.body

  if (body?.missing) {
    return {
      heading: 'Cannot approve this product yet.',
      items: body.missing.map((field) => MISSING_FIELD_MESSAGES[field] || `${field} is missing`),
    }
  }

  if (body?.error === 'PRICE_VIOLATES_DEMAND_POLICY') {
    return {
      heading: "This price doesn't match observed buyer demand.",
      items: (body.details || []).map((detail) => describePriceViolation(detail, price)),
    }
  }

  if (body?.error === 'DEMAND_POLICY_UNVERIFIABLE') {
    return {
      heading: "SmartCart can't verify this product's original demand evidence anymore, so it can't be approved as-is.",
      items: [],
    }
  }

  if (body?.details) {
    return { heading: 'Cannot save this product.', items: body.details }
  }

  if (error.status === 404) {
    return { heading: 'This product could not be found - it may have already been deleted.', items: [] }
  }

  if (error.status === 409) {
    return { heading: "This product's status changed - refreshing the list.", items: [] }
  }

  if (body?.message) {
    return { heading: body.message, items: [] }
  }

  if (body?.error) {
    return { heading: body.error, items: [] }
  }

  return { heading: error.message || 'Something went wrong. Please try again.', items: [] }
}

function ProductList({ products, onEdit, onApprove, onReject, onDelete }) {
  const [rowState, setRowState] = useState({})

  async function runAction(product, action, actionFn) {
    setRowState((prev) => ({ ...prev, [product.id]: { acting: action, error: null, confirmingDelete: false } }))
    try {
      await actionFn(product)
      setRowState((prev) => ({ ...prev, [product.id]: { acting: null, error: null, confirmingDelete: false } }))
    } catch (error) {
      setRowState((prev) => ({
        ...prev,
        [product.id]: { acting: null, error: describeApiError(error, product.price), confirmingDelete: false },
      }))
    }
  }

  function toggleDeleteConfirm(productId, show) {
    setRowState((prev) => ({ ...prev, [productId]: { ...prev[productId], confirmingDelete: show } }))
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
                <span className={`source-badge ${product.sourceType === 'AI_OPPORTUNITY' ? 'source-badge--ai' : ''}`}>
                  {product.sourceType === 'AI_OPPORTUNITY' && <Sparkles size={11} strokeWidth={2.25} aria-hidden="true" />}
                  {SOURCE_LABELS[product.sourceType] || product.sourceType}
                  {product.sourceType === 'AI_OPPORTUNITY' && product.status === 'PENDING_REVIEW' && ' · Pending review'}
                </span>
              </div>
              <div className="product-row__meta">
                <span className="num-tabular">{formatPrice(product)}</span>
                <span>{product.category || 'Uncategorized'}</span>
                <span>{product.sku ? `SKU: ${product.sku}` : 'No SKU'}</span>
                <span>
                  {product.availability}
                  {product.stockQuantity !== null ? ` · Qty: ${product.stockQuantity}` : ' · Qty unknown'}
                </span>
              </div>
            </div>

            <div className="product-row__actions">
              <button type="button" disabled={Boolean(state.acting)} onClick={() => onEdit(product)}>
                Edit
              </button>
              <button
                type="button"
                className="btn-primary"
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
              <button
                type="button"
                disabled={Boolean(state.acting)}
                onClick={() => toggleDeleteConfirm(product.id, true)}
              >
                Delete
              </button>
            </div>

            {state.confirmingDelete && (
              <div className="delete-confirm">
                <p className="delete-confirm__title">Delete this product?</p>
                <p className="delete-confirm__body">
                  This will remove the product from your AI Commerce catalog. This action cannot be undone.
                </p>
                <div className="delete-confirm__actions">
                  <button type="button" onClick={() => toggleDeleteConfirm(product.id, false)}>
                    Cancel
                  </button>
                  <button type="button" onClick={() => runAction(product, 'delete', (p) => onDelete(p))}>
                    {state.acting === 'delete' ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            )}

            {state.error && (
              <div className="product-row__error">
                <p className="product-row__error-heading">{state.error.heading}</p>
                {state.error.items.length > 0 && (
                  <ul className="product-row__error-list">
                    {state.error.items.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default ProductList
