import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { productsRouter } from "./products.js";

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
