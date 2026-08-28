import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import { ShoppingBag, CheckCircle2 } from 'lucide-react'
import { sendChatMessage, createCheckoutOrder, verifyPayment, addBundleToCart, addProductToCart, ApiError } from '../lib/api.js'
import { formatMoney } from '../lib/formatMoney.js'
import PaymentSuccessCard from './PaymentSuccessCard.jsx'
import BundleCard from './BundleCard.jsx'
import WhyThis from './WhyThis.jsx'

// Example prompts only — never fake product data. Clicking one just fills
// the input; the existing handleSubmit flow runs completely unchanged.
const SUGGESTION_CHIPS = ['Find a gift', 'Under ₹1000', 'Popular items']

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
  return formatMoney(product.price)
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
        return 'That message is too long - please shorten it.'
      default:
        return 'Something went wrong. Please try again.'
    }
  }
  return 'Could not reach the shopping assistant. Please try again.'
}

// Phase 4A: the Razorpay Checkout script is lazy-loaded only when the
// customer actually clicks "Proceed to payment" — never on every page load.
let razorpayScriptPromise = null
function loadRazorpayCheckoutScript() {
  if (window.Razorpay) return Promise.resolve()
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      script.onload = () => resolve()
      script.onerror = () => {
        razorpayScriptPromise = null
        reject(new Error('SCRIPT_LOAD_FAILED'))
      }
      document.body.appendChild(script)
    })
  }
  return razorpayScriptPromise
}

// The cart executors (cartTools.js) already produce customer-facing-quality
// messages for every error case ("This product is currently out of stock.",
// "The available quantity isn't confirmed..."). Reusing that message
// directly avoids a second, drifting copy of the same error text.
function describeAddToCartError(error) {
  if (error instanceof ApiError && error.body?.message) return error.body.message
  return 'Could not add this to your cart. Please try again.'
}

function describeCheckoutError(error) {
  const code = error instanceof ApiError ? error.body?.error : null
  switch (code) {
    case 'MISSING_CREDENTIALS':
    case 'NOT_TEST_MODE':
      return "Payment isn't configured yet - please try again later."
    case 'CART_EMPTY':
      return 'Your cart is empty.'
    case 'CART_NOT_READY':
      return "Some items in your cart are no longer available. Please review your cart before paying."
    case 'PRICE_CHANGED':
      return 'A price changed since you added it to your cart. Please review the updated cart before paying.'
    case 'CART_CHANGED':
      return 'Your cart changed. Please review it before paying.'
    case 'RAZORPAY_API_ERROR':
      return 'The payment provider is temporarily unavailable - please try again.'
    default:
      return 'Could not start payment. Please try again.'
  }
}

// `cartState` is this one product's own add-to-cart attempt state
// ({status: 'adding'|'added'|'error', message?}), keyed by productId in the
// parent so every card showing the same product agrees on it. The button is
// a direct, visible commerce action alongside conversational ordering — it
// never replaces "yes" -> Gemini add_to_cart, which keeps working unchanged.
function ProductCard({ product, onAddToCart, cartState }) {
  const hasQty = product.stockQuantity !== null && product.stockQuantity !== undefined
  const inStock = product.availability === 'IN_STOCK'
  // Same purchasability rule already used elsewhere in this codebase
  // (opportunityLoop.js/OpportunityDetail.jsx's isProductPurchasable) — a
  // product can be IN_STOCK with an unconfirmed exact quantity (stockQuantity
  // null), which is still fine for a single-unit add.
  const purchasable = inStock && (product.stockQuantity === null || product.stockQuantity >= 1)
  const availabilityLine = inStock && hasQty ? `In stock · ${product.stockQuantity} available` : humanizeAvailability(product.availability)
  const initial = product.name ? product.name.charAt(0).toUpperCase() : '?'
  const status = cartState?.status

  return (
    <div className="chat-product-card">
      <span className="chat-product-card__placeholder" aria-hidden="true">
        {initial}
      </span>
      <div className="chat-product-card__body">
        <p className="chat-product-card__name">{product.name}</p>
        {product.category && <p className="chat-product-card__category">{product.category}</p>}
        <p className="chat-product-card__price num-tabular">{formatPrice(product)}</p>
        <p className={`chat-product-card__availability ${inStock ? 'chat-product-card__availability--in-stock' : ''}`}>
          {availabilityLine}
        </p>
        {product.merchant?.name && <p className="chat-product-card__merchant">Sold by {product.merchant.name}</p>}
        <WhyThis facts={product.why} />
        {/* UNKNOWN/OUT_OF_STOCK never get a misleading active button - the
            availability line above is already the honest reason, so no
            button is shown at all rather than a disabled one with no
            explanation. */}
        {purchasable && onAddToCart && (
          <button
            type="button"
            className="chat-product-card__add-button"
            onClick={() => onAddToCart(product.id)}
            disabled={status === 'adding' || status === 'added'}
          >
            {status === 'adding' ? 'Adding…' : status === 'added' ? 'Added ✓' : 'Add to cart'}
          </button>
        )}
        {status === 'error' && cartState?.message && <p className="chat-product-card__add-error">{cartState.message}</p>}
      </div>
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
      <div className="cart-summary__header">
        <span className="cart-summary__title">
          <ShoppingBag size={15} strokeWidth={2} aria-hidden="true" />
          Your cart
        </span>
        <span className="cart-summary__subtotal num-tabular">{formatMoney(cart.subtotal)}</span>
      </div>
      <p className="field-hint">
        {cart.itemCount} item{cart.itemCount === 1 ? '' : 's'}
      </p>
      <ul className="cart-summary__items">
        {cart.items.map((item) => (
          <li key={item.productId} className="cart-summary__item">
            <span className="cart-summary__item-name">
              {item.name}
              {item.blocked && <span className="cart-summary__item-blocked"> (currently unavailable)</span>}
            </span>
            <span className="cart-summary__item-detail num-tabular">
              {item.quantity} × {formatMoney(item.unitPrice)} = {formatMoney(item.lineTotal)}
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
  // Phase 4A: checkoutReady comes only from the backend's deterministic
  // checkout-readiness state on the latest response — Gemini never sets
  // this directly, and it is never inferred from message text.
  const [checkoutReady, setCheckoutReady] = useState(false)
  const [payment, setPayment] = useState({ status: 'idle' }) // idle | processing | awaiting-payment | verifying | verified | error
  // Direct "Add to cart" button state, keyed by productId - {status, message}.
  // Independent of the conversational cart flow above; both write to the
  // SAME backend cart, just through two different trusted entry points.
  const [cartActions, setCartActions] = useState({})

  // Resets only this component's own local conversation state — never
  // touches the database or any merchant-side state (Catalog/Orders/
  // Opportunities live in a structurally separate part of the app, see
  // App.jsx). The next message sent after this passes conversationId as
  // undefined, so the backend creates a genuinely fresh conversation UUID —
  // exactly like a first-ever message, or a full page reload, already does.
  function startNewChat() {
    setConversationId(null)
    setMessages([])
    setCart(null)
    setInput('')
    setError(null)
    setCheckoutReady(false)
    setPayment({ status: 'idle' })
    setCartActions({})
  }

  async function handleSubmit(event) {
    event.preventDefault()
    const text = input.trim()
    if (text === '' || sending) return

    setMessages((prev) => [...prev, { role: 'user', text }])
    setInput('')
    setSending(true)
    setError(null)
    setPayment({ status: 'idle' })

    try {
      const result = await sendChatMessage(conversationId ?? undefined, text)
      setConversationId(result.conversationId)
      setCart(result.cart ?? null)
      setCheckoutReady(Boolean(result.checkoutReady))
      setMessages((prev) => {
        const next = [
          ...prev,
          { role: 'assistant', text: result.message, products: result.products, bundle: result.bundle, isFallback: Boolean(result.isFallback) },
        ]
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

  // Deterministic, non-Gemini action behind BundleCard's "Add all to cart"
  // button — mirrors handleProceedToPayment's separation from the chat loop.
  async function handleAddPlanToCart() {
    const result = await addBundleToCart(conversationId)
    setCart(result.cart)
    setCheckoutReady(false)
    return result
  }

  // Deterministic action behind a product card's direct "Add to cart"
  // button - goes through the SAME trusted backend cart path (add_to_cart's
  // own executor/grounding rule) the conversational "yes" flow uses, just
  // via a dedicated endpoint instead of a Gemini tool call. Guards against a
  // double click while a request for this exact product is already in
  // flight or already succeeded.
  async function handleAddToCart(productId) {
    if (!conversationId) return
    const current = cartActions[productId]?.status
    if (current === 'adding' || current === 'added') return

    setCartActions((prev) => ({ ...prev, [productId]: { status: 'adding' } }))
    try {
      const result = await addProductToCart(conversationId, productId)
      setCart(result.cart)
      setCheckoutReady(false)
      setCartActions((prev) => ({ ...prev, [productId]: { status: 'added' } }))
    } catch (err) {
      setCartActions((prev) => ({ ...prev, [productId]: { status: 'error', message: describeAddToCartError(err) } }))
    }
  }

  // Deterministic, button-driven payment flow — never routed through Gemini.
  // Success is shown ONLY after POST /api/checkout/verify-payment returns
  // verified: true; the Razorpay handler firing alone is never enough.
  async function handleProceedToPayment() {
    if (!conversationId) return
    setPayment({ status: 'processing' })

    let order
    try {
      order = await createCheckoutOrder(conversationId)
    } catch (err) {
      if (err instanceof ApiError && err.body?.cart) {
        // Cart changed/blocked/emptied since it was last shown — refresh
        // the visible cart and require the customer to reconfirm; never
        // silently retry with a different amount.
        setCart(err.body.cart)
        setCheckoutReady(false)
      }
      setPayment({ status: 'error', message: describeCheckoutError(err) })
      return
    }

    try {
      await loadRazorpayCheckoutScript()
    } catch {
      setPayment({ status: 'error', message: "Couldn't load the payment provider - please check your connection and try again." })
      return
    }

    const razorpayInstance = new window.Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      name: order.name,
      description: order.description,
      order_id: order.razorpayOrderId,
      handler: async (response) => {
        setPayment({ status: 'verifying' })
        try {
          const verifyResult = await verifyPayment({
            checkoutId: order.checkoutId,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_signature: response.razorpay_signature,
          })
          if (verifyResult?.verified && verifyResult.order) {
            setPayment({ status: 'verified' })
            setCheckoutReady(false)
            // Backend-authored order confirmation — never Gemini-generated,
            // never an invented order number. Wording differs for a payment
            // that's captured (final) vs. merely authorized (Razorpay is
            // still finalizing it) — the cart is only cleared server-side
            // for the captured case, reflected on the next chat turn.
            const { order } = verifyResult
            const text =
              order.paymentStatus === 'CAPTURED'
                ? `Payment received. Order ${order.orderNumber} is confirmed.\n${formatMoney(order.total)} · ${order.itemCount} item${order.itemCount === 1 ? '' : 's'}`
                : `Payment received. Order ${order.orderNumber} is being confirmed by the payment provider.\n${formatMoney(order.total)} · ${order.itemCount} item${order.itemCount === 1 ? '' : 's'}`
            setMessages((prev) => [...prev, { role: 'assistant', text, kind: 'payment-success' }])
          } else {
            setPayment({ status: 'error', message: "We couldn't verify this payment. Please try again or contact support." })
          }
        } catch {
          setPayment({ status: 'error', message: "We couldn't verify this payment. Please try again or contact support." })
        }
      },
      modal: {
        // Dismissal is not a failure — quietly return to the ready-to-pay
        // state, never show success and never show an error banner.
        ondismiss: () => setPayment({ status: 'idle' }),
      },
    })

    razorpayInstance.on('payment.failed', () => {
      setPayment({ status: 'error', message: 'The payment failed. Please try again.' })
    })

    setPayment({ status: 'awaiting-payment' })
    razorpayInstance.open()
  }

  return (
    <div className="customer-chat">
      <div className="customer-chat__column">
        <div className="customer-chat__header">
          <button type="button" className="link-button" onClick={startNewChat} disabled={sending}>
            + New chat
          </button>
        </div>

        <div className="customer-chat__history">
          {messages.length === 0 && (
            <div className="customer-chat__welcome">
              <p className="customer-chat__welcome-kicker">AI SHOPPING ASSISTANT</p>
              <p className="customer-chat__welcome-title">What do you want to buy?</p>
              <p className="customer-chat__welcome-subtitle">Tell me what you need, your budget, or who it's for.</p>
              <div className="customer-chat__chips">
                {SUGGESTION_CHIPS.map((chip) => (
                  <button type="button" key={chip} className="chip" onClick={() => setInput(chip)}>
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((entry, index) =>
            entry.kind === 'payment-success' ? (
              <PaymentSuccessCard key={index} text={entry.text} />
            ) : (
              <div key={index} className={`chat-message chat-message--${entry.role}`}>
                {entry.role === 'assistant' ? <AssistantText text={entry.text} /> : <p>{entry.text}</p>}
                {entry.products && entry.products.length > 0 && (
                  <div className="chat-product-list">
                    {entry.isFallback && (
                      <p className="field-hint">No exact match found — here are available options within your budget:</p>
                    )}
                    {entry.products.map((product) => (
                      <ProductCard
                        key={product.id}
                        product={product}
                        onAddToCart={handleAddToCart}
                        cartState={cartActions[product.id]}
                      />
                    ))}
                  </div>
                )}
                {entry.bundle && <BundleCard bundle={entry.bundle} onAddAll={handleAddPlanToCart} />}
              </div>
            )
          )}
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
            aria-label="Chat message"
            placeholder="Ask about products…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={sending}
          />
          <button type="submit" className="btn-primary" disabled={sending || input.trim() === ''}>
            Send
          </button>
        </form>
      </div>

      <div className="customer-chat__cart-panel">
        <CartSummary cart={cart} />

        {checkoutReady && (
          <div className="checkout-card">
            <h4>
              <CheckCircle2 size={14} strokeWidth={2.25} aria-hidden="true" />
              Ready to checkout
            </h4>
            <p className="checkout-card__summary num-tabular">
              {cart.itemCount} item{cart.itemCount === 1 ? '' : 's'} · {cart.currency} {cart.subtotal}
            </p>
            <button
              type="button"
              className="checkout-actions__pay-button"
              onClick={handleProceedToPayment}
              disabled={payment.status === 'processing' || payment.status === 'awaiting-payment' || payment.status === 'verifying'}
            >
              {payment.status === 'processing' && 'Preparing payment…'}
              {payment.status === 'verifying' && 'Verifying payment…'}
              {(payment.status === 'idle' || payment.status === 'error' || payment.status === 'awaiting-payment') &&
                'Proceed to payment'}
            </button>
            {payment.status === 'error' && <p className="checkout-actions__error">{payment.message}</p>}
          </div>
        )}

        {!cart?.items?.length && !checkoutReady && (
          <p className="empty-state">Your cart is empty. Ask AI to add an item.</p>
        )}
      </div>
    </div>
  )
}

export default CustomerChat
