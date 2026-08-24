import Razorpay from "razorpay";
import { createHmac, timingSafeEqual } from "node:crypto";

// The ONLY file that imports the Razorpay SDK or touches
// RAZORPAY_KEY_SECRET. Never logs either credential, never returns
// KEY_SECRET in any response — only KEY_ID (the public key) ever reaches
// checkout.js's route responses, and only KEY_ID/KEY_SECRET together ever
// reach this module.

let client = null;

// Checked before every order-creation attempt (never cached as a boolean),
// so a credential that's added/changed while the server is running is
// picked up on the next call rather than requiring a restart.
export function getRazorpayConfigStatus() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return { ok: false, reason: "MISSING_CREDENTIALS" };
  }
  if (!keyId.startsWith("rzp_test_")) {
    // Refuse rather than silently proceed — this phase is TEST MODE ONLY.
    return { ok: false, reason: "NOT_TEST_MODE" };
  }
  return { ok: true };
}

function getClient() {
  if (!client) {
    client = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return client;
}

// Caller (checkout.js route) must have already checked
// getRazorpayConfigStatus().ok before calling this.
export async function createTestOrder({ amountMinor, currency, receipt }) {
  try {
    const order = await getClient().orders.create({ amount: amountMinor, currency, receipt });
    return { order };
  } catch (error) {
    // Razorpay SDK errors carry a nested `.error.description` — logged
    // without ever including request credentials.
    console.error("[razorpay] order creation failed:", error?.error?.description || error.message);
    return { error: "RAZORPAY_API_ERROR" };
  }
}

// Phase 4B: server-side source of truth for what actually happened to a
// payment — never trust the frontend/Gemini for amount/currency/status,
// always re-fetch from Razorpay itself before creating a durable order.
export async function fetchPayment(paymentId) {
  try {
    const payment = await getClient().payments.fetch(paymentId);
    return { payment };
  } catch (error) {
    console.error("[razorpay] payment fetch failed:", error?.error?.description || error.message);
    return { error: "PAYMENT_FETCH_FAILED" };
  }
}

// HMAC-SHA256(storedRazorpayOrderId + "|" + paymentId, KEY_SECRET), compared
// with crypto.timingSafeEqual — but ONLY once both buffers are confirmed to
// be the same length, since timingSafeEqual throws (not returns false) on a
// length mismatch. A malformed or wrong-length submitted signature must
// resolve to "invalid", never an unhandled exception / 500.
export function verifySignature({ storedRazorpayOrderId, paymentId, submittedSignature }) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;

  const expectedHex = createHmac("sha256", secret).update(`${storedRazorpayOrderId}|${paymentId}`).digest("hex");
  const expectedBuffer = Buffer.from(expectedHex, "hex");
  const submittedBuffer = Buffer.from(typeof submittedSignature === "string" ? submittedSignature : "", "hex");

  if (expectedBuffer.length !== submittedBuffer.length || expectedBuffer.length === 0) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, submittedBuffer);
}
