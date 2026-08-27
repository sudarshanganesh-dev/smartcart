import { prisma } from "../src/lib/prisma.js";

// SmartCart Final Demo Dataset — deterministic reset.
//
// Returns the ONE known demo merchant (slug "demo-merchant") to an exact,
// intentional starting state, every time this script runs — safe to run
// after a failed rehearsal, a completed brownie purchase, or anything else
// the live demo loop might leave behind. It does this by fully deleting and
// rebuilding ONLY that merchant's Product/Opportunity/DemandEvent/Order/
// OrderItem graph inside a single transaction — never a partial diff, so
// there is no drift between runs and no cross-run duplication.
//
// This script talks to Prisma directly. It deliberately does NOT call
// generateDraftForOpportunity (that requires a live Gemini call and is not
// deterministic) or any other Feature 1/2/3 application code — the rows it
// creates are hand-built to be byte-shape-identical to what that real flow
// produces, without touching or depending on it.

const DEMO_MERCHANT_SLUG = "demo-merchant";
const DEMO_MERCHANT_NAME = "SweetCrumb Bakery";

// Safety guard — this script always performs a full delete of the demo
// merchant's transactional data. That is only ever safe for a disposable
// demo/dev environment, never a real production database. Refuses to run
// under NODE_ENV=production unless explicitly overridden.
if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_RESET !== "true") {
  console.error("[seed:demo] Refusing to run with NODE_ENV=production. Set ALLOW_DEMO_RESET=true to override.");
  process.exit(1);
}

// The intended starting catalog. `sku` is the natural key this script uses
// to identify "the same" product across runs (Prisma's own cuid() ids are
// never reused, and are never relied on for idempotency here).
const CATALOG = [
  {
    sku: "SC-BROWNIE-001",
    name: "Brownie Box",
    category: "Brownies",
    description: "A box of six fudgy, double-chocolate brownies, baked fresh daily.",
    price: 499,
    availability: "IN_STOCK",
    stockQuantity: 8,
    status: "APPROVED",
    sourceType: "MANUAL",
  },
  {
    sku: "SC-CAKE-CHOC-001",
    name: "Classic Chocolate Cake",
    category: "Cakes",
    description: "A rich, moist chocolate layer cake finished with dark chocolate ganache.",
    price: 499,
    availability: "IN_STOCK",
    stockQuantity: 10,
    status: "APPROVED",
    sourceType: "MANUAL",
  },
  {
    sku: "SC-CAKE-REDVELVET-001",
    name: "Red Velvet Cake",
    category: "Cakes",
    description: "Classic red velvet sponge layered with cream cheese frosting.",
    price: 599,
    availability: "IN_STOCK",
    stockQuantity: 8,
    status: "APPROVED",
    sourceType: "MANUAL",
  },
  {
    sku: "SC-CAKE-BLACKFOREST-001",
    name: "Black Forest Cake",
    category: "Cakes",
    description: "Chocolate sponge, whipped cream, and cherries in the traditional Black Forest style.",
    price: 549,
    availability: "IN_STOCK",
    stockQuantity: 7,
    status: "APPROVED",
    sourceType: "FILE_UPLOAD",
  },
  {
    sku: "SC-CAKE-VANILLA-001",
    name: "Vanilla Celebration Cake",
    category: "Cakes",
    description: "A light vanilla sponge cake with buttercream, ideal for birthdays and celebrations.",
    price: 449,
    availability: "IN_STOCK",
    stockQuantity: 9,
    status: "APPROVED",
    sourceType: "FILE_UPLOAD",
  },
  {
    sku: "SC-CUPCAKE-CHOC-001",
    name: "Chocolate Cupcake Box",
    category: "Cupcakes",
    description: "A box of six chocolate cupcakes topped with chocolate buttercream.",
    price: 349,
    availability: "IN_STOCK",
    stockQuantity: 12,
    status: "APPROVED",
    sourceType: "FILE_UPLOAD",
  },
  {
    sku: "SC-COOKIES-BUTTER-001",
    name: "Butter Cookies Box",
    category: "Cookies",
    description: "A box of freshly baked, all-butter cookies.",
    price: 249,
    availability: "IN_STOCK",
    stockQuantity: 15,
    status: "APPROVED",
    sourceType: "MANUAL",
  },
  {
    sku: "SC-CHEESECAKE-001",
    name: "Baked Cheesecake",
    category: "Cheesecakes",
    description: "A classic baked cheesecake with a buttery biscuit base.",
    price: 549,
    availability: "IN_STOCK",
    stockQuantity: 6,
    status: "APPROVED",
    sourceType: "MANUAL",
  },
  {
    sku: "SC-TART-FRUIT-001",
    name: "Seasonal Fruit Tart",
    category: "Tarts",
    description: "A crisp pastry tart topped with seasonal fresh fruit and glaze.",
    price: 399,
    availability: "IN_STOCK",
    stockQuantity: 5,
    status: "PENDING_REVIEW",
    sourceType: "FILE_UPLOAD",
  },
];

async function wipeDemoMerchantData(tx, merchantId) {
  // Dependency-safe order — OrderItem/Order have a real Prisma relation;
  // everything else is a plain string reference (see schema comments), so
  // order among those doesn't matter, but this order is still the clearest.
  await tx.orderItem.deleteMany({ where: { merchantId } });
  await tx.order.deleteMany({ where: { merchantId } });
  await tx.opportunity.deleteMany({ where: { merchantId } });
  await tx.demandEvent.deleteMany({ where: { merchantId } });
  await tx.product.deleteMany({ where: { merchantId } });
}

async function createCatalog(tx, merchantId) {
  const products = {};
  for (const item of CATALOG) {
    const product = await tx.product.create({
      data: {
        merchantId,
        name: item.name,
        description: item.description,
        sku: item.sku,
        category: item.category,
        price: item.price,
        currency: "INR",
        availability: item.availability,
        stockQuantity: item.stockQuantity,
        status: item.status,
        sourceType: item.sourceType,
      },
    });
    products[item.sku] = product;
  }
  return products;
}

// One clean historical AI-generated success — mirrors the real "cake under
// ₹100" story this project has used throughout development (3 NO_MATCH
// DemandEvents -> automatic Opportunity -> AI-drafted VARIANT -> merchant
// price/approval -> 1 PAID order), hand-built so it is internally
// consistent (groupKey/Opportunity/Product/DemandEvents/Order all agree)
// without depending on a live Gemini call. This is a DIFFERENT demand
// cluster (groupKey) from the live-demo Brownie opportunity below — one
// Opportunity is never made to serve both the "already resolved" and
// "reserved for the live demo" roles.
async function createHistoricalAiSuccess(tx, merchantId) {
  const groupKey = `${merchantId}|NO_MATCH|cake|max:<=100`;
  const conversationIds = ["demo-seed-conv-cake-1", "demo-seed-conv-cake-2", "demo-seed-conv-cake-3"];
  const baseTime = new Date("2026-08-20T10:00:00.000Z");

  for (let i = 0; i < conversationIds.length; i++) {
    await tx.demandEvent.create({
      data: {
        merchantId,
        conversationId: conversationIds[i],
        reason: "NO_MATCH",
        groupKey,
        queryText: "cake",
        minPrice: null,
        maxPrice: 100,
        budgetBand: "<=100",
        estimatedValue: 100,
        createdAt: new Date(baseTime.getTime() + i * 60_000),
      },
    });
  }

  const opportunity = await tx.opportunity.create({
    data: {
      merchantId,
      groupKey,
      reason: "NO_MATCH",
      status: "OPEN",
      firstSeenAt: baseTime,
      lastSeenAt: new Date(baseTime.getTime() + 2 * 60_000),
    },
  });

  const product = await tx.product.create({
    data: {
      merchantId,
      name: "Classic Celebration Cake",
      description: "A small, budget-friendly celebration cake created by SmartCart in response to real customer demand.",
      sku: "SC-AI-CAKE-001",
      category: "Cakes",
      price: 95,
      currency: "INR",
      availability: "IN_STOCK",
      stockQuantity: 15,
      status: "APPROVED",
      sourceType: "AI_OPPORTUNITY",
      originOpportunityId: opportunity.id,
      createdAt: new Date(baseTime.getTime() + 3 * 60_000),
    },
  });

  await tx.opportunity.update({
    where: { id: opportunity.id },
    data: {
      status: "ACTIONED",
      actionedAt: new Date(baseTime.getTime() + 3 * 60_000),
      generatedProductId: product.id,
      signalCountAtAction: 3,
    },
  });

  return product;
}

// The live-demo opportunity, deliberately left OPEN and un-actioned — 3
// real NO_MATCH DemandEvents for "brownie under ₹200" (same groupKey/facts
// the app's own automatic threshold logic would produce for 3 real
// searches), then a real Opportunity row at the resulting threshold, and
// nothing more. No generated product, no order, no actionedAt, no
// signalCountAtAction — intentionally left for the live demo to action
// itself via the real, unmodified generateDraftForOpportunity flow, never
// pre-resolved by the seed. A DIFFERENT groupKey from the historical cake
// success above, so the two never share or contend for the same
// Opportunity row. The real catalog already has an approved "Brownie Box"
// at ₹499 (see CATALOG above), so the detail page's live getCatalogGap
// check honestly finds it and recommends a lower-priced version — this
// seed does not fabricate or force that outcome, it only creates the real
// demand facts that make the existing, unmodified logic arrive there.
async function createBrownieOpenOpportunity(tx, merchantId) {
  const groupKey = `${merchantId}|NO_MATCH|brownie|max:<=250`;
  const conversationIds = ["demo-seed-conv-brownie-1", "demo-seed-conv-brownie-2", "demo-seed-conv-brownie-3"];
  const baseTime = new Date("2026-08-23T10:00:00.000Z");

  for (let i = 0; i < conversationIds.length; i++) {
    await tx.demandEvent.create({
      data: {
        merchantId,
        conversationId: conversationIds[i],
        reason: "NO_MATCH",
        groupKey,
        queryText: "brownie",
        minPrice: null,
        maxPrice: 200,
        budgetBand: "<=250",
        estimatedValue: 200,
        createdAt: new Date(baseTime.getTime() + i * 60_000),
      },
    });
  }

  await tx.opportunity.create({
    data: {
      merchantId,
      groupKey,
      reason: "NO_MATCH",
      status: "OPEN",
      firstSeenAt: baseTime,
      lastSeenAt: new Date(baseTime.getTime() + 2 * 60_000),
    },
  });
}

async function createPaidOrder(tx, { merchantId, orderNumber, razorpayOrderId, razorpayPaymentId, createdAt, item }) {
  const subtotal = item.unitPrice * item.quantity;
  return tx.order.create({
    data: {
      merchantId,
      orderNumber,
      status: "PAID",
      paymentStatus: "CAPTURED",
      currency: "INR",
      subtotal,
      total: subtotal,
      razorpayOrderId,
      razorpayPaymentId,
      createdAt,
      items: {
        create: [
          {
            merchantId,
            productId: item.productId,
            productName: item.productName,
            sku: item.sku,
            unitPrice: item.unitPrice,
            quantity: item.quantity,
            lineTotal: subtotal,
          },
        ],
      },
    },
  });
}

async function main() {
  let merchant;

  await prisma.$transaction(
    async (tx) => {
      merchant = await tx.merchant.upsert({
        where: { slug: DEMO_MERCHANT_SLUG },
        update: { name: DEMO_MERCHANT_NAME },
        create: { name: DEMO_MERCHANT_NAME, slug: DEMO_MERCHANT_SLUG },
      });

      await wipeDemoMerchantData(tx, merchant.id);

      const products = await createCatalog(tx, merchant.id);
      const aiProduct = await createHistoricalAiSuccess(tx, merchant.id);
      await createBrownieOpenOpportunity(tx, merchant.id);

      await createPaidOrder(tx, {
        merchantId: merchant.id,
        orderNumber: "DEMO-SEED-000001",
        razorpayOrderId: "demo_seed_order_ai_cake",
        razorpayPaymentId: "demo_seed_payment_ai_cake",
        createdAt: new Date("2026-08-20T10:03:30.000Z"),
        item: {
          productId: aiProduct.id,
          productName: aiProduct.name,
          sku: aiProduct.sku,
          unitPrice: 95,
          quantity: 1,
        },
      });

      const redVelvet = products["SC-CAKE-REDVELVET-001"];
      await createPaidOrder(tx, {
        merchantId: merchant.id,
        orderNumber: "DEMO-SEED-000002",
        razorpayOrderId: "demo_seed_order_redvelvet",
        razorpayPaymentId: "demo_seed_payment_redvelvet",
        createdAt: new Date("2026-08-21T11:15:00.000Z"),
        item: {
          productId: redVelvet.id,
          productName: redVelvet.name,
          sku: redVelvet.sku,
          unitPrice: 599,
          quantity: 1,
        },
      });

      const cheesecake = products["SC-CHEESECAKE-001"];
      await createPaidOrder(tx, {
        merchantId: merchant.id,
        orderNumber: "DEMO-SEED-000003",
        razorpayOrderId: "demo_seed_order_cheesecake",
        razorpayPaymentId: "demo_seed_payment_cheesecake",
        createdAt: new Date("2026-08-22T09:45:00.000Z"),
        item: {
          productId: cheesecake.id,
          productName: cheesecake.name,
          sku: cheesecake.sku,
          unitPrice: 549,
          quantity: 1,
        },
      });
    },
    { timeout: 20000 }
  );

  console.log(`[seed:demo] Reset complete for merchant ${merchant.id} (${merchant.name}, slug: ${merchant.slug})`);
}

main()
  .catch((error) => {
    console.error("[seed:demo] Failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
