import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { listOrdersForMerchant, getOrderForMerchant } from "../lib/orders/orderQueries.js";

export const shopOrdersRouter = Router();

// This app has no customer-identity/auth system at all (Order has no
// customerId — only merchantId and a best-effort conversationId), and the
// demo has exactly one merchant. "My Orders" on the Customer surface is
// therefore this store's orders, resolved server-side the same way the
// frontend already resolves "the" demo merchant — never exposing a
// merchantId in the customer-facing URL/UI. This is a demo-appropriate
// simplification, not a real per-customer order history.
async function resolveStoreMerchant() {
  const bySlug = await prisma.merchant.findUnique({ where: { slug: "demo-merchant" } });
  if (bySlug) return bySlug;
  return prisma.merchant.findFirst({ orderBy: { createdAt: "asc" } });
}

// Explicit allow-list, customer-safe subset of the merchant-facing detail
// DTO — deliberately drops razorpayOrderId/razorpayPaymentId and any
// internal id. Reuses getOrderForMerchant's existing query/DTO rather than
// duplicating the Prisma query — this file only re-shapes the response.
function toCustomerOrderDetailDTO(order) {
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    currency: order.currency,
    subtotal: order.subtotal,
    total: order.total,
    createdAt: order.createdAt,
    items: order.items.map((item) => ({
      productName: item.productName,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
    })),
  };
}

shopOrdersRouter.get("/", async (req, res) => {
  try {
    const merchant = await resolveStoreMerchant();
    if (!merchant) {
      return res.json([]);
    }
    const orders = await listOrdersForMerchant({ merchantId: merchant.id });
    // listOrdersForMerchant's own DTO is already customer-safe (no Razorpay
    // IDs, no internal-only fields) — reused verbatim.
    res.json(orders);
  } catch (error) {
    console.error("[shop-orders] list failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

shopOrdersRouter.get("/:orderId", async (req, res) => {
  try {
    const merchant = await resolveStoreMerchant();
    if (!merchant) {
      return res.status(404).json({ error: "ORDER_NOT_FOUND" });
    }
    const order = await getOrderForMerchant({ merchantId: merchant.id, orderId: req.params.orderId });
    if (!order) {
      return res.status(404).json({ error: "ORDER_NOT_FOUND" });
    }
    res.json(toCustomerOrderDetailDTO(order));
  } catch (error) {
    console.error("[shop-orders] detail failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
