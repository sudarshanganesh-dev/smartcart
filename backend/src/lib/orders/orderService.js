import { prisma } from "../prisma.js";
import { lineTotal, fromMinorUnits } from "../ai/buyer/cart.js";

// Two different concepts, never confused: a Razorpay Order is the payment
// gateway's entity (razorpayOrderId, "order_xxx"); a commerce Order (this
// file) is our own durable purchase record.

const ORDER_NUMBER_PREFIX = "ACL";

function formatDateForOrderNumber(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// captured -> PAID/CAPTURED (fulfillable in a later phase); authorized ->
// PAYMENT_PENDING/AUTHORIZED (a real, signature-verified payment, but not
// yet final — Razorpay itself can still auto-refund an authorized payment
// that's never captured within its own capture window).
function statusesForPaymentStatus(razorpayPaymentStatus) {
  return razorpayPaymentStatus === "captured"
    ? { status: "PAID", paymentStatus: "CAPTURED" }
    : { status: "PAYMENT_PENDING", paymentStatus: "AUTHORIZED" };
}

async function createOrderFromCheckout({ checkout, payment }) {
  const merchantId = checkout.cartSnapshot[0]?.merchantId;
  if (!merchantId) {
    // Should be unreachable — the cart's merchant lock (cartTools.js)
    // guarantees every line shares one merchantId before checkout can even
    // be created — but fail loudly rather than silently mis-attributing an
    // order if that invariant is ever violated.
    throw new Error("checkout.cartSnapshot is missing merchantId — cannot attribute commerce order to a merchant");
  }

  const { status, paymentStatus } = statusesForPaymentStatus(payment.status);
  const subtotal = fromMinorUnits(checkout.amountMinor);

  try {
    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          merchantId,
          conversationId: checkout.conversationId ?? null,
          status,
          paymentStatus,
          currency: checkout.currency,
          subtotal,
          total: subtotal, // no tax/shipping in Phase 4B
          razorpayOrderId: checkout.razorpayOrderId,
          razorpayPaymentId: payment.id,
          items: {
            create: checkout.cartSnapshot.map((item) => ({
              productId: item.productId,
              merchantId: item.merchantId,
              productName: item.name,
              sku: item.sku ?? null,
              unitPrice: item.priceSnapshot,
              quantity: item.quantity,
              lineTotal: lineTotal(item),
            })),
          },
        },
        include: { items: true },
      });

      // orderNumber depends on the autoincrement sequenceNumber, which only
      // exists once the row is inserted — a second, tiny update within the
      // SAME transaction, so the order never exists (even momentarily)
      // without its human-readable number.
      const orderNumber = `${ORDER_NUMBER_PREFIX}-${formatDateForOrderNumber(created.createdAt)}-${String(created.sequenceNumber).padStart(6, "0")}`;
      return tx.order.update({ where: { id: created.id }, data: { orderNumber }, include: { items: true } });
    });

    return { order, isNew: true };
  } catch (error) {
    if (error.code === "P2002") {
      // Lost a genuine concurrent race to another request creating the same
      // razorpayPaymentId/razorpayOrderId — the DB-level unique constraint,
      // not this code, is what actually prevents the duplicate. Return the
      // winner's row instead of surfacing an error.
      const winner = await prisma.order.findUnique({ where: { razorpayPaymentId: payment.id }, include: { items: true } });
      if (winner) return { order: winner, isNew: false };
    }
    throw error;
  }
}

// The single entry point for turning a server-verified Razorpay payment into
// (or onto) a durable commerce Order. Idempotent and safe under concurrency:
// - no existing order for this razorpayPaymentId -> create one (captured or
//   authorized, per payment.status)
// - existing order still AUTHORIZED and this payment is now captured ->
//   transition it to PAID/CAPTURED in place (never a second order)
// - existing order already CAPTURED, or still AUTHORIZED with nothing new ->
//   return it unchanged
//
// `shouldClearCart` is true only when this call results in a CAPTURED order
// — an AUTHORIZED order intentionally leaves the temporary cart intact,
// since payment isn't final yet (approved adjustment to the Phase 4B plan).
export async function recordPaymentOrder({ checkout, payment }) {
  const existing = await prisma.order.findUnique({
    where: { razorpayPaymentId: payment.id },
    include: { items: true },
  });

  if (existing) {
    if (existing.paymentStatus === "CAPTURED") {
      return { order: existing, isNew: false, transitioned: false, shouldClearCart: false };
    }
    if (payment.status === "captured") {
      const updated = await prisma.order.update({
        where: { id: existing.id },
        data: { status: "PAID", paymentStatus: "CAPTURED" },
        include: { items: true },
      });
      return { order: updated, isNew: false, transitioned: true, shouldClearCart: true };
    }
    // Still authorized, nothing changed since last time.
    return { order: existing, isNew: false, transitioned: false, shouldClearCart: false };
  }

  const { order, isNew } = await createOrderFromCheckout({ checkout, payment });
  return { order, isNew, transitioned: false, shouldClearCart: order.paymentStatus === "CAPTURED" };
}

// Backend-authored shape for the customer response — no internal DB id,
// merchantId, conversationId, or Razorpay identifiers.
export function formatOrderResponse(order) {
  const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    currency: order.currency,
    total: order.total.toFixed(2),
    itemCount,
  };
}
