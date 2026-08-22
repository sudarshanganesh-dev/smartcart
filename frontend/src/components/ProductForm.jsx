import { useState } from 'react'
import { ApiError } from '../lib/api.js'

const AVAILABILITY_OPTIONS = ['IN_STOCK', 'OUT_OF_STOCK', 'UNKNOWN']

function toFieldValue(value) {
  return value === null || value === undefined ? '' : String(value)
}

function buildInitialFields(product) {
  return {
    name: toFieldValue(product?.name),
    description: toFieldValue(product?.description),
    price: toFieldValue(product?.price),
    currency: toFieldValue(product?.currency),
    category: toFieldValue(product?.category),
    sku: toFieldValue(product?.sku),
    // Left blank (not pre-selected) for a new product so the merchant must
    // explicitly choose a state rather than silently inheriting one.
    availability: product?.availability || '',
    stockQuantity: toFieldValue(product?.stockQuantity),
  }
}

function buildPayload(fields) {
  const name = fields.name.trim()
  const price = fields.price.trim() === '' ? null : Number(fields.price)
  const stockQuantity = fields.stockQuantity.trim() === '' ? null : Number(fields.stockQuantity)

  if (price !== null && Number.isNaN(price)) {
    throw new Error('Price must be a number')
  }
  if (stockQuantity !== null && Number.isNaN(stockQuantity)) {
    throw new Error('Stock quantity must be a whole number')
  }

  return {
    name,
    description: fields.description.trim() === '' ? null : fields.description,
    price,
    currency: fields.currency.trim() === '' ? null : fields.currency.trim().toUpperCase(),
    category: fields.category.trim() === '' ? null : fields.category,
    sku: fields.sku.trim() === '' ? null : fields.sku,
    availability: fields.availability,
    stockQuantity,
  }
}

function ProductForm({ product, onSubmit, onCancel, submitLabel }) {
  const [fields, setFields] = useState(() => buildInitialFields(product))
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState([])

  const isEdit = Boolean(product)

  function updateField(key, value) {
    setFields((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setErrors([])

    const missing = []
    if (fields.name.trim() === '') missing.push('Name is required')
    if (!isEdit) {
      if (fields.price.trim() === '') missing.push('Price is required')
      if (fields.currency.trim() === '') missing.push('Currency is required')
      if (fields.category.trim() === '') missing.push('Category is required')
      if (fields.availability.trim() === '') missing.push('Availability is required')
    }
    if (missing.length > 0) {
      setErrors(missing)
      return
    }

    let payload
    try {
      payload = buildPayload(fields)
    } catch (error) {
      setErrors([error.message])
      return
    }

    setSaving(true)
    try {
      await onSubmit(payload)
    } catch (error) {
      if (error instanceof ApiError && error.body?.details) {
        setErrors(error.body.details)
      } else if (error instanceof ApiError && error.body?.message) {
        setErrors([error.body.message])
      } else if (error instanceof ApiError) {
        setErrors([error.message])
      } else {
        setErrors(['Something went wrong. Please try again.'])
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="product-form" onSubmit={handleSubmit}>
      <h3>{isEdit ? 'Edit product' : 'Add product'}</h3>

      {errors.length > 0 && (
        <ul className="form-errors">
          {errors.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      )}

      <label>
        Name *
        <input
          type="text"
          value={fields.name}
          onChange={(e) => updateField('name', e.target.value)}
          required
        />
      </label>

      <label>
        Description (optional)
        <textarea
          value={fields.description}
          onChange={(e) => updateField('description', e.target.value)}
        />
      </label>

      <div className="product-form__row">
        <label>
          Price{!isEdit && ' *'}
          <input
            type="number"
            step="0.01"
            min="0"
            value={fields.price}
            onChange={(e) => updateField('price', e.target.value)}
            required={!isEdit}
          />
        </label>

        <label>
          Currency{!isEdit && ' *'}
          <input
            type="text"
            placeholder="e.g. INR"
            maxLength={3}
            value={fields.currency}
            onChange={(e) => updateField('currency', e.target.value)}
            required={!isEdit}
          />
        </label>
      </div>

      <div className="product-form__row">
        <label>
          Category{!isEdit && ' *'}
          <input
            type="text"
            value={fields.category}
            onChange={(e) => updateField('category', e.target.value)}
            required={!isEdit}
          />
        </label>

        <label>
          SKU (optional)
          <input
            type="text"
            value={fields.sku}
            onChange={(e) => updateField('sku', e.target.value)}
          />
          <span className="field-hint">Your store's internal product code, if you use one.</span>
        </label>
      </div>

      <div className="product-form__row">
        <label>
          Availability{!isEdit && ' *'}
          <select
            value={fields.availability}
            onChange={(e) => updateField('availability', e.target.value)}
            required={!isEdit}
          >
            <option value="" disabled hidden>
              Select availability…
            </option>
            {AVAILABILITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label>
          Stock quantity (optional)
          <input
            type="number"
            step="1"
            min="0"
            placeholder="Unknown"
            value={fields.stockQuantity}
            onChange={(e) => updateField('stockQuantity', e.target.value)}
          />
        </label>
      </div>

      <div className="product-form__actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : submitLabel || (isEdit ? 'Save changes' : 'Create product')}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  )
}

export default ProductForm
