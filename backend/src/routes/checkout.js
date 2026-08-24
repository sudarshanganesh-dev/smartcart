import { Router } from "express";
import { randomUUID } from "node:crypto";
import { getCartForConversation, clearCartForConversation } from "../lib/ai/buyer/buyerAgent.js";
import { validateCartForCheckout } from "../lib/ai/buyer/cartTools.js";
import { toMinorUnits, computeCartFingerprint } from "../lib/ai/buyer/cart.js";
import { getRazorpayConfigStatus, createTestOrder, verifySignature, fetchPayment } from "../lib/payments/razorpayClient.js";
import {
  createCheckout,
  findReusableCheckout,
  getCheckout,
  isCheckoutExpired,
  markVerified,
  linkCommerceOrder,
} from "../lib/payments/checkoutStore.js";
import { recordPaymentOrder, formatOrderResponse } from "../lib/orders/orderService.js";
import { prisma } from "../lib/prisma.js";

export const checkoutRouter = Router();

// The frontend sends only conversationId. Everything else — cart contents,
// amount, currency, product IDs, quantities, price, receipt — is derived
// entirely from trusted server-side conversation/cart state, exactly as
// required: the create-order request body is never trusted for any of it.
checkoutRouter.post("/create-order", async (req, res) => {
  try {
    await handleCreateOrder(req, res);
  } catch (error) {
    // Express 4 does not catch a rejected promise from an async handler —
    // an unexpected failure here (e.g. a DB error) must still resolve to a
    // clean, safe response rather than leaving the request hanging.
    console.error("[checkout] create-order failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

async function handleCreateOrder(req, res) {
  const { conversationId } = req.body || {};
  if (typeof conversationId !== "string" || conversationId.trim() === "") {
    return res.status(400).json({ error: "INVALID_CONVERSATION" });
  }

  const cart = getCartForConversation(conversationId);
  if (!cart) {
    return res.status(404).json({ error: "UNKNOWN_CONVERSATION" });
  }

  const configStatus = getRazorpayConfigStatus();
  if (!configStatus.ok) {
    // Stop here — before any real Razorpay API call — rather than proceed
    // with missing or non-test-mode credentials.
    return res.status(503).json({ error: configStatus.reason });
  }

  // Re-validate against trusted commerce truth immediately before creating
  // an order — the same revalidation used by view_cart/request_checkout,
  // PLUS an explicit quantity-vs-current-stock re-check (validateCartForCheckout),
  // never a separate/looser check.
  const { cart: revalidated, removed, priceChanges, insufficientStock } = await validateCartForCheckout(cart);

  if (revalidated.items.length === 0) {
    return res.status(400).json({ error: "CART_EMPTY", cart: revalidated, removed });
  }
  const blockedItems = revalidated.items.filter((item) => item.blocked);
  if (blockedItems.length > 0) {
    return res.status(409).json({ error: "CART_NOT_READY", cart: revalidated, blockedItems, removed });
  }
  if (insufficientStock.length > 0) {
    return res.status(409).json({ error: "CART_NOT_READY", cart: revalidated, insufficientStock, removed });
  }
  if (priceChanges.length > 0) {
    // Decision 4: ANY trusted price change blocks order creation, no
    // threshold — the cart is refreshed to current trusted prices and
    // returned so the customer can see and explicitly reconfirm.
    return res.status(409).json({ error: "PRICE_CHANGED", cart: revalidated, priceChanges });
  }
  if (removed.length > 0) {
    // A stale line was dropped (deleted/PENDING/REJECTED) even though the
    // remaining cart is otherwise clean — still requires reconfirmation
    // rather than silently checking out a smaller cart than last shown.
    return res.status(409).json({ error: "CART_CHANGED", cart: revalidated, removed });
  }

  // Addition 1: create-order idempotency. A deterministic fingerprint of
  // the exact trusted cart contents (never one supplied by the frontend) —
  // an unexpired, not-yet-verified checkout with the same conversationId +
  // fingerprint is reused instead of creating a second Razorpay Order.
  const fingerprint = computeCartFingerprint(cart);
  const reusable = findReusableCheckout(conversationId, fingerprint);
  if (reusable) {
    return res.json({
      checkoutId: reusable.checkoutId,
      razorpayOrderId: reusable.razorpayOrderId,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: reusable.amountMinor,
      currency: reusable.currency,
      name: "SmartCart",
      description: "Order payment",
    });
  }

  const amountMinor = toMinorUnits(revalidated.subtotal);
  const orderResult = await createTestOrder({
    amountMinor,
    currency: revalidated.currency,
    receipt: `chk_${randomUUID().replace(/-/g, "").slice(0, 32)}`,
  });
  if (orderResult.error) {
    return res.status(502).json({ error: orderResult.error });
  }

  // Phase 4B: the snapshot locked here is what durable OrderItems will
  // later be built from — raw cart lines (including merchantId/sku), never
  // the customer-facing display DTO, and never anything reconstructed later
  // from the frontend or the Razorpay callback. A shallow copy so later
  // cart mutations (if any, before payment completes) can never retroactively
  // change what this checkout is locked to.
  const cartSnapshot = cart.items.map((item) => ({ ...item }));

  const record = createCheckout({
    conversationId,
    razorpayOrderId: orderResult.order.id,
    amountMinor,
    currency: revalidated.currency,
    cartSnapshot,
    cartFingerprint: fingerprint,
  });

  res.json({
    checkoutId: record.checkoutId,
    razorpayOrderId: record.razorpayOrderId,
    keyId: process.env.RAZORPAY_KEY_ID,
    amount: record.amountMinor,
    currency: record.currency,
    name: "SmartCart",
    description: "Order payment",
  });
}

checkoutRouter.post("/verify-payment", async (req, res) => {
  try {
    await handleVerifyPayment(req, res);
  } catch (error) {
    // Same reasoning as create-order: never let an unexpected failure (e.g.
    // recordPaymentOrder's transaction throwing) hang the request. Cart
    // clearing only ever happens after a successful response is built, so a
    // caught failure here also guarantees the cart was never cleared.
    console.error("[checkout] verify-payment failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

async function handleVerifyPayment(req, res) {
  const { checkoutId, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body || {};

  if (
    typeof checkoutId !== "string" ||
    typeof razorpay_payment_id !== "string" ||
    typeof razorpay_order_id !== "string" ||
    typeof razorpay_signature !== "string" ||
    checkoutId === "" ||
    razorpay_payment_id === "" ||
    razorpay_order_id === "" ||
    razorpay_signature === ""
  ) {
    return res.status(400).json({ error: "INVALID_ARGUMENTS" });
  }

  const record = getCheckout(checkoutId);
  if (!record) {
    return res.status(404).json({ error: "UNKNOWN_CHECKOUT" });
  }

  if (record.status === "verified") {
    // Addition 2 (unchanged): a different payment/order id may never
    // piggyback on an already-verified checkoutId.
    if (razorpay_payment_id !== record.verifiedPaymentId || razorpay_order_id !== record.razorpayOrderId) {
      return res.status(409).json({ error: "ALREADY_VERIFIED_MISMATCH" });
    }
    // Ids match. If we already have a fully CAPTURED order for this
    // checkout, this is a pure replay — return it without hitting Razorpay
    // again. If the linked order is still AUTHORIZED (or the DB write
    // failed last time and no order is linked at all), fall through below
    // to re-check with Razorpay — this is exactly the "a later captured
    // verification transitions the same order" path, never a new order.
    if (record.commerceOrderId) {
      const existingOrder = await prisma.order.findUnique({ where: { id: record.commerceOrderId }, include: { items: true } });
      if (existingOrder?.paymentStatus === "CAPTURED") {
        return res.json({ verified: true, order: formatOrderResponse(existingOrder) });
      }
    }
    // NOTE: no expiry check here — once genuinely signature-verified, an
    // authorized payment may legitimately take Razorpay up to a few days to
    // capture (or auto-refund), and re-verification must keep working for
    // that whole window, not just the original 15-minute checkout TTL.
  } else {
    if (isCheckoutExpired(record)) {
      return res.status(410).json({ error: "CHECKOUT_EXPIRED" });
    }
    // IMPORTANT: the callback's razorpay_order_id is only ever compared
    // against our own stored value — it is never itself used as the HMAC
    // input's source of truth (that's always record.razorpayOrderId).
    if (razorpay_order_id !== record.razorpayOrderId) {
      return res.status(400).json({ error: "ORDER_MISMATCH" });
    }
    const signatureValid = verifySignature({
      storedRazorpayOrderId: record.razorpayOrderId,
      paymentId: razorpay_payment_id,
      submittedSignature: razorpay_signature,
    });
    if (!signatureValid) {
      return res.status(400).json({ error: "SIGNATURE_INVALID" });
    }
    markVerified(checkoutId, razorpay_payment_id);
  }

  // Phase 4B: signature verification alone is not sufficient to create/
  // transition a durable order — fetch the payment server-side and check
  // it actually matches what this checkout expects.
  const paymentResult = await fetchPayment(razorpay_payment_id);
  if (paymentResult.error) {
    return res.status(502).json({ error: "PAYMENT_FETCH_FAILED" });
  }
  const payment = paymentResult.payment;

  if (
    payment.order_id !== record.razorpayOrderId ||
    payment.amount !== record.amountMinor ||
    payment.currency !== record.currency
  ) {
    return res.status(400).json({ error: "PAYMENT_MISMATCH" });
  }
  if (payment.status !== "captured" && payment.status !== "authorized") {
    return res.status(400).json({ error: "PAYMENT_NOT_SUCCESSFUL" });
  }

  const { order, shouldClearCart } = await recordPaymentOrder({ checkout: record, payment });
  linkCommerceOrder(checkoutId, order.id);

  // Approved adjustment: the temporary cart is cleared ONLY once the
  // payment is confirmed CAPTURED and the durable PAID order transaction has
  // succeeded. An AUTHORIZED order intentionally leaves the cart intact —
  // payment isn't final yet.
  if (shouldClearCart) {
    clearCartForConversation(record.conversationId);
  }

  res.json({ verified: true, order: formatOrderResponse(order) });
}
