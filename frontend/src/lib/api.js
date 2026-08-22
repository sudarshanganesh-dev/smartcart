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
