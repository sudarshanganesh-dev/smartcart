export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000'

export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

async function request(path, options = {}) {
  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    })
  } catch {
    throw new ApiError('Could not reach the backend', { status: null, body: null })
  }

  const text = await response.text()
  const body = text ? JSON.parse(text) : null

  if (!response.ok) {
    throw new ApiError(body?.error || 'Request failed', { status: response.status, body })
  }

  return body
}

function normalizeProduct(product) {
  if (!product) return product
  return {
    ...product,
    price: product.price === null || product.price === undefined ? null : Number(product.price),
  }
}

export async function getMerchants() {
  const merchants = await request('/api/merchants')
  return merchants
}

export async function getProducts(merchantId, status) {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  const products = await request(`/api/merchants/${merchantId}/products${query}`)
  return products.map(normalizeProduct)
}

export async function createProduct(merchantId, payload) {
  const product = await request(`/api/merchants/${merchantId}/products`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return normalizeProduct(product)
}

export async function updateProduct(merchantId, productId, payload) {
  const product = await request(`/api/merchants/${merchantId}/products/${productId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
  return normalizeProduct(product)
}

export async function approveProduct(merchantId, productId) {
  const product = await request(`/api/merchants/${merchantId}/products/${productId}/approve`, {
    method: 'POST',
  })
  return normalizeProduct(product)
}

export async function rejectProduct(merchantId, productId) {
  const product = await request(`/api/merchants/${merchantId}/products/${productId}/reject`, {
    method: 'POST',
  })
  return normalizeProduct(product)
}

export async function deleteProduct(merchantId, productId) {
  return request(`/api/merchants/${merchantId}/products/${productId}`, {
    method: 'DELETE',
  })
}

export async function crawlWebsite(merchantId, url) {
  return request(`/api/merchants/${merchantId}/products/crawl`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

// Deliberately does NOT run products through normalizeProduct(): the
// commerce/customer API's price is a canonical decimal STRING end to end
// (Phase 3A Decision 3) and must never be coerced into a JS float on the way
// to display, unlike the merchant-management API's product shape.
export async function sendChatMessage(conversationId, message) {
  return request('/api/customer/chat', {
    method: 'POST',
    body: JSON.stringify({ conversationId, message }),
  })
}

// Phase 4A: the frontend sends only conversationId — amount/currency/cart
// contents are never supplied by the client, matching the backend contract.
export async function createCheckoutOrder(conversationId) {
  return request('/api/checkout/create-order', {
    method: 'POST',
    body: JSON.stringify({ conversationId }),
  })
}

export async function verifyPayment(payload) {
  return request('/api/checkout/verify-payment', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

// Deterministic "Add all to cart" action for a SmartCart Plan — a dedicated
// endpoint outside the chat/Gemini loop, the same way createCheckoutOrder is.
export async function addBundleToCart(conversationId) {
  return request('/api/customer/bundle/add-all', {
    method: 'POST',
    body: JSON.stringify({ conversationId }),
  })
}

// Phase 5: read-only merchant order visibility. Money stays exact decimal
// strings end to end, same reasoning as sendChatMessage — never run through
// normalizeProduct()'s float coercion.
export async function getOrders(merchantId, status) {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  return request(`/api/merchants/${merchantId}/orders${query}`)
}

export async function getOrder(merchantId, orderId) {
  return request(`/api/merchants/${merchantId}/orders/${orderId}`)
}

// Phase 7: read-only opportunity visibility + lifecycle actions. Money/score
// fields stay exact decimal strings / plain integers straight from the
// backend, same reasoning as getOrders — never run through normalizeProduct().
export async function getOpportunities(merchantId, status) {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  return request(`/api/merchants/${merchantId}/opportunities${query}`)
}

export async function getOpportunity(merchantId, opportunityId) {
  return request(`/api/merchants/${merchantId}/opportunities/${opportunityId}`)
}

export async function dismissOpportunity(merchantId, opportunityId) {
  return request(`/api/merchants/${merchantId}/opportunities/${opportunityId}/dismiss`, {
    method: 'POST',
  })
}

export async function generateOpportunityDraft(merchantId, opportunityId) {
  return request(`/api/merchants/${merchantId}/opportunities/${opportunityId}/generate-draft`, {
    method: 'POST',
  })
}

// Phase 8: read-only dashboard aggregation for the Merchant Overview page.
export async function getDashboardSummary(merchantId) {
  return request(`/api/merchants/${merchantId}/dashboard-summary`)
}

// Phase 8 UX pass: customer-facing "My Orders" — a customer-safe view of
// this store's orders (no Razorpay IDs, no internal fields). See
// backend/src/routes/shopOrders.js for why this doesn't take a merchantId.
export async function getShopOrders() {
  return request('/api/shop/orders')
}

export async function getShopOrder(orderId) {
  return request(`/api/shop/orders/${orderId}`)
}

export async function importCatalog(merchantId, format, file) {
  const formData = new FormData()
  formData.append('format', format)
  formData.append('file', file)

  let response
  try {
    response = await fetch(`${API_BASE_URL}/api/merchants/${merchantId}/products/import`, {
      method: 'POST',
      body: formData,
    })
  } catch {
    throw new ApiError('Could not reach the backend', { status: null, body: null })
  }

  const text = await response.text()
  const body = text ? JSON.parse(text) : null

  if (!response.ok) {
    throw new ApiError(body?.error || 'Request failed', { status: response.status, body })
  }

  return body
}
