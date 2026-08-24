import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { productsRouter } from "./products.js";
import { ordersRouter } from "./orders.js";
import { opportunitiesRouter } from "./opportunities.js";
import { getDashboardSummary } from "../lib/intelligence/dashboardService.js";

export const merchantsRouter = Router();

merchantsRouter.get("/", async (req, res) => {
  const merchants = await prisma.merchant.findMany({
    orderBy: { createdAt: "asc" },
  });
  res.json(merchants);
});

merchantsRouter.use(
  "/:merchantId/products",
  async (req, res, next) => {
    const merchant = await prisma.merchant.findUnique({
      where: { id: req.params.merchantId },
    });

    if (!merchant) {
      return res.status(404).json({ error: "MERCHANT_NOT_FOUND" });
    }

    req.merchant = merchant;
    next();
  },
  productsRouter
);

// Phase 5: read-only order visibility, generic for any valid merchantId —
// same existence check as /:merchantId/products above, deliberately
// duplicated rather than shared so the existing products mount is never
// touched by this addition.
merchantsRouter.use(
  "/:merchantId/orders",
  async (req, res, next) => {
    const merchant = await prisma.merchant.findUnique({
      where: { id: req.params.merchantId },
    });

    if (!merchant) {
      return res.status(404).json({ error: "MERCHANT_NOT_FOUND" });
    }

    req.merchant = merchant;
    next();
  },
  ordersRouter
);

// Phase 7: merchant Opportunities workspace — same existence-check pattern
// as products/orders above, deliberately duplicated rather than shared so
// neither existing mount is touched by this addition.
merchantsRouter.use(
  "/:merchantId/opportunities",
  async (req, res, next) => {
    const merchant = await prisma.merchant.findUnique({
      where: { id: req.params.merchantId },
    });

    if (!merchant) {
      return res.status(404).json({ error: "MERCHANT_NOT_FOUND" });
    }

    req.merchant = merchant;
    next();
  },
  opportunitiesRouter
);

// Phase 8: read-only dashboard aggregation — a single endpoint, no
// sub-resources, so it's inlined here rather than a separate router file.
// Same existence-check pattern as the mounts above.
merchantsRouter.get("/:merchantId/dashboard-summary", async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { id: req.params.merchantId } });
  if (!merchant) {
    return res.status(404).json({ error: "MERCHANT_NOT_FOUND" });
  }
  try {
    const summary = await getDashboardSummary(merchant.id);
    res.json(summary);
  } catch (error) {
    console.error("[dashboard] summary failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
