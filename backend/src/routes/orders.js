import { Router } from "express";
import { listOrdersForMerchant, getOrderForMerchant } from "../lib/orders/orderQueries.js";

// Mounted under /:merchantId/orders by merchants.js, behind the same
// merchant-existence check already used for /:merchantId/products —
// req.merchant is guaranteed to exist and belong to this merchantId by the
// time either handler here runs. Read-only: no POST/PATCH/DELETE exist.
export const ordersRouter = Router();

const VALID_STATUS_FILTERS = ["PAID", "PAYMENT_PENDING"];
const DEFAULT_LIMIT = 50;

ordersRouter.get("/", async (req, res) => {
  const { status } = req.query;
  if (status !== undefined && !VALID_STATUS_FILTERS.includes(status)) {
    return res.status(400).json({ error: "INVALID_STATUS_FILTER" });
  }

  try {
    const orders = await listOrdersForMerchant({
      merchantId: req.merchant.id,
      status,
      limit: DEFAULT_LIMIT,
    });
    res.json(orders);
  } catch (error) {
    console.error("Failed to list orders:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

ordersRouter.get("/:orderId", async (req, res) => {
  try {
    const order = await getOrderForMerchant({ merchantId: req.merchant.id, orderId: req.params.orderId });
    if (!order) {
      return res.status(404).json({ error: "ORDER_NOT_FOUND" });
    }
    res.json(order);
  } catch (error) {
    console.error("Failed to get order:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
