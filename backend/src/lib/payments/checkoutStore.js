import { randomUUID } from "node:crypto";

// Temporary in-memory checkout state — same rationale as the cart itself
// (Phase 3C): bounded, TTL'd, restart-losable by design. No Prisma table;
// nothing here needs to survive a restart for this phase.
const CHECKOUT_TTL_MS = 15 * 60 * 1000; // 15 minutes (Decision 2)
const MAX_CHECKOUTS = 500; // pure hygiene bound, mirrors MAX_CONVERSATIONS

const checkouts = new Map(); // checkoutId -> record

function isExpired(record) {
  return Date.now() - record.createdAt > CHECKOUT_TTL_MS;
}

export function isCheckoutExpired(record) {
  return isExpired(record);
}

export function createCheckout({ conversationId, razorpayOrderId, amountMinor, currency, cartSnapshot, cartFingerprint }) {
  const checkoutId = randomUUID();
  const record = {
    checkoutId,
    conversationId,
    razorpayOrderId,
    amountMinor,
    currency,
    cartSnapshot,
    cartFingerprint,
    createdAt: Date.now(),
    status: "created", // "created" | "verified" (Decision: no larger state machine yet)
    verifiedPaymentId: null,
    // Phase 4B: links this checkout to its durable commerce Order once one
    // exists — lets a repeat verify-payment call skip straight to "already
    // captured, return as-is" without re-hitting the Razorpay API, while
    // still allowing an AUTHORIZED order to be re-checked and transitioned.
    commerceOrderId: null,
  };
  checkouts.set(checkoutId, record);
  if (checkouts.size > MAX_CHECKOUTS) {
    const oldestKey = checkouts.keys().next().value;
    checkouts.delete(oldestKey);
  }
  return record;
}

// Create-order idempotency (Addition 1): reuse an unexpired, not-yet-verified
// checkout for this exact conversation + cart fingerprint, instead of
// creating a second Razorpay Order for a double-click / retry with an
// unchanged cart. Never trusts a fingerprint from the frontend — the caller
// (checkout.js route) always recomputes it server-side from trusted cart
// state before calling this.
export function findReusableCheckout(conversationId, cartFingerprint) {
  for (const record of checkouts.values()) {
    if (
      record.conversationId === conversationId &&
      record.cartFingerprint === cartFingerprint &&
      record.status === "created" &&
      !isExpired(record)
    ) {
      return record;
    }
  }
  return null;
}

export function getCheckout(checkoutId) {
  return checkouts.get(checkoutId) || null;
}

export function markVerified(checkoutId, paymentId) {
  const record = checkouts.get(checkoutId);
  if (!record) return null;
  record.status = "verified";
  record.verifiedPaymentId = paymentId;
  return record;
}

export function linkCommerceOrder(checkoutId, orderId) {
  const record = checkouts.get(checkoutId);
  if (!record) return null;
  record.commerceOrderId = orderId;
  return record;
}
