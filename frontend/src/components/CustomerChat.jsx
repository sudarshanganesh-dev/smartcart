import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import { sendChatMessage, ApiError } from '../lib/api.js'

// Markdown is restricted to a small safe subset (bold, italic, lists, line
// breaks) purely for display formatting. react-markdown never parses raw
// HTML out of the box (no rehype-raw plugin is used here), so this cannot
// execute arbitrary markup even though the text originates from an LLM.
const MARKDOWN_ALLOWED_ELEMENTS = ['p', 'strong', 'em', 'ul', 'ol', 'li', 'br']

function AssistantText({ text }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkBreaks]} allowedElements={MARKDOWN_ALLOWED_ELEMENTS} unwrapDisallowed>
      {text}
    </ReactMarkdown>
  )
}

function formatPrice(product) {
  if (product.price === null || product.price === undefined) return 'Price unknown'
  return `${product.currency || ''} ${product.price}`.trim()
}

function humanizeAvailability(availability) {
  switch (availability) {
    case 'IN_STOCK':
      return 'In stock'
    case 'OUT_OF_STOCK':
      return 'Out of stock'
    case 'UNKNOWN':
      return 'Availability unknown'
    default:
      return availability
  }
}

function describeError(error) {
  if (error instanceof ApiError && error.body?.error) {
    switch (error.body.error) {
      case 'INVALID_MESSAGE':
        return 'Please type a message first.'
      case 'MESSAGE_TOO_LONG':
        return 'That message is too long — please shorten it.'
      default:
        return 'Something went wrong. Please try again.'
    }
  }
  return 'Could not reach the shopping assistant. Please try again.'
}

function ProductCard({ product }) {
  const hasQty = product.stockQuantity !== null && product.stockQuantity !== undefined
  const availabilityLine =
    product.availability === 'IN_STOCK' && hasQty
      ? `In stock · ${product.stockQuantity} available`
      : humanizeAvailability(product.availability)

  return (
    <div className="chat-product-card">
      <p className="chat-product-card__name">{product.name}</p>
      <p className="chat-product-card__price">{formatPrice(product)}</p>
      <p className="chat-product-card__availability">{availabilityLine}</p>
      {product.merchant?.name && <p className="chat-product-card__merchant">Sold by {product.merchant.name}</p>}
    </div>
  )
}

// Phase 3C: read-only cart summary. Deliberately no quantity/remove
// controls here — cart mutation stays exclusively conversational, through
// Gemini + the bounded, grounded cart tools, not a second ungrounded path.
function CartSummary({ cart }) {
  if (!cart || cart.items.length === 0) return null

  return (
    <div className="cart-summary">
      <p className="cart-summary__header">
        🛒 {cart.itemCount} item{cart.itemCount === 1 ? '' : 's'} · {cart.currency} {cart.subtotal}
      </p>
      <ul className="cart-summary__items">
        {cart.items.map((item) => (
          <li key={item.productId} className="cart-summary__item">
            <span className="cart-summary__item-name">
              {item.name}
              {item.blocked && <span className="cart-summary__item-blocked"> (currently unavailable)</span>}
            </span>
            <span className="cart-summary__item-detail">
              {item.quantity} × {item.unitPrice} = {item.lineTotal}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function CustomerChat() {
  const [conversationId, setConversationId] = useState(null)
  const [messages, setMessages] = useState([])
  const [cart, setCart] = useState(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(event) {
    event.preventDefault()
    const text = input.trim()
    if (text === '' || sending) return

    setMessages((prev) => [...prev, { role: 'user', text }])
    setInput('')
    setSending(true)
    setError(null)

    try {
      const result = await sendChatMessage(conversationId ?? undefined, text)
      setConversationId(result.conversationId)
      setCart(result.cart ?? null)
      setMessages((prev) => {
        const next = [...prev, { role: 'assistant', text: result.message, products: result.products }]
        // followUp is rendered as its own bubble, appearing after the product
        // card rather than folded into the main reply's text.
        if (result.followUp) {
          next.push({ role: 'assistant', text: result.followUp })
        }
        return next
      })
    } catch (err) {
      setError(describeError(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="customer-chat">
      <CartSummary cart={cart} />

      <div className="customer-chat__history">
        {messages.length === 0 && (
          <p className="empty-state">Ask about a product — e.g. &ldquo;Show me coffee gifts under ₹2000&rdquo;.</p>
        )}
        {messages.map((entry, index) => (
          <div key={index} className={`chat-message chat-message--${entry.role}`}>
            {entry.role === 'assistant' ? <AssistantText text={entry.text} /> : <p>{entry.text}</p>}
            {entry.products && entry.products.length > 0 && (
              <div className="chat-product-list">
                {entry.products.map((product) => (
                  <ProductCard key={product.id} product={product} />
                ))}
              </div>
            )}
          </div>
        ))}
        {sending && <p className="field-hint">Thinking…</p>}
      </div>

      {error && (
        <div className="error-banner">
          <p>{error}</p>
        </div>
      )}

      <form className="customer-chat__input" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Ask about products…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={sending}
        />
        <button type="submit" disabled={sending || input.trim() === ''}>
          Send
        </button>
      </form>
    </div>
  )
}

export default CustomerChat
