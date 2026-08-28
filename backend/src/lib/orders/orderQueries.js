import { prisma } from "../prisma.js";

// Read-only queries for the Phase 5 merchant Orders workspace. Deliberately
// separate from orderService.js's write/idempotency logic — this file never
// mutates an Order and never talks to Razorpay, so the working payment
// pipeline (Phase 4B) stays untouched by anything added here.

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

// Small, list-appropriate DTO — no line items, no Razorpay identifiers, no
// internal-only fields (sequenceNumber, conversationId, merchantId).
// `aiProductIds` is the same authoritative AI-attribution relationship
// already used for the Overview's verified AI revenue (see
// dashboardService.js's buildAiRevenueImpact): an order counts as
// AI-attributed only when one of its real OrderItem.productId values
// belongs to a Product with sourceType AI_OPPORTUNITY — never inferred from
// amount, order number, product name, or date.
function toOrderListDTO(order, aiProductIds) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    currency: order.currency,
    total: order.total.toFixed(2),
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    aiAttributed: order.items.some((item) => item.productId && aiProductIds.has(item.productId)),
    createdAt: order.createdAt,
  };
}

// Fuller merchant-facing detail DTO — includes Razorpay IDs (legitimate
// reconciliation metadata for a merchant) and the immutable per-item
// snapshot, but still no checkoutId, no conversationId, no payment
// credentials, and no internal-only fields.
function toOrderDetailDTO(order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    currency: order.currency,
    subtotal: order.subtotal.toFixed(2),
    total: order.total.toFixed(2),
    createdAt: order.createdAt,
    razorpayOrderId: order.razorpayOrderId,
    razorpayPaymentId: order.razorpayPaymentId,
    items: order.items.map((item) => ({
      productName: item.productName,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: item.unitPrice.toFixed(2),
      lineTotal: item.lineTotal.toFixed(2),
    })),
  };
}

// Works generically for any merchantId — never hardcodes a specific
// merchant. `status`, when provided, must already be a validated
// "PAID" | "PAYMENT_PENDING" (the route layer validates this before calling
// in, matching the existing merchant-route convention).
export async function listOrdersForMerchant({ merchantId, status, limit = DEFAULT_LIMIT }) {
  const boundedLimit = Math.min(Math.max(1, limit), MAX_LIMIT);
  const where = { merchantId, ...(status ? { status } : {}) };

  const [orders, aiProducts] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: boundedLimit,
    }),
    // One batch query for the whole merchant, not one lookup per order/item —
    // same reasoning as loadStatsByGroupKey/loadRepresentativeByGroupKey in
    // opportunityService.js.
    prisma.product.findMany({ where: { merchantId, sourceType: "AI_OPPORTUNITY" }, select: { id: true } }),
  ]);
  const aiProductIds = new Set(aiProducts.map((p) => p.id));

  return orders.map((order) => toOrderListDTO(order, aiProductIds));
}

// Scoped by BOTH orderId and merchantId in the same query — an order that
// exists but belongs to a different merchant is indistinguishable from one
// that doesn't exist at all, exactly like getMerchantById's existing
// "doesn't exist" vs "not authorized" pattern elsewhere in this codebase.
export async function getOrderForMerchant({ merchantId, orderId }) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, merchantId },
    include: { items: true },
  });
  return order ? toOrderDetailDTO(order) : null;
}
