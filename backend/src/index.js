import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { healthRouter } from "./routes/health.js";
import { merchantsRouter } from "./routes/merchants.js";
import { commerceRouter } from "./routes/commerce.js";
import { customerRouter } from "./routes/customer.js";
import { checkoutRouter } from "./routes/checkout.js";
import { shopOrdersRouter } from "./routes/shopOrders.js";
import { chatLimiter, checkoutLimiter } from "./lib/rateLimit.js";

const app = express();
const PORT = process.env.PORT || 4000;

// Baseline security headers only — no CSP. This API serves no HTML, and a
// default CSP would risk interfering with the frontend's separately-loaded
// Razorpay Checkout script/iframe, which this server has no visibility into.
app.use(helmet({ contentSecurityPolicy: false }));

// ALLOWED_ORIGINS unset (local dev/demo default): permissive reflection,
// same behavior as before Phase 6. Set ALLOWED_ORIGINS to a comma-separated
// list to restrict to specific origins in a real deployment.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
  : null;
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : {}));

app.use(express.json({ limit: "256kb" }));

app.use("/api/health", healthRouter);
app.use("/api/merchants", merchantsRouter);
app.use("/api/commerce", commerceRouter);
app.use("/api/customer", chatLimiter, customerRouter);
app.use("/api/checkout", checkoutLimiter, checkoutRouter);
// Read-only, no limiter (matches the existing GET-endpoint policy) —
// mounted at its own top-level path so it never inherits chatLimiter, which
// is only meant for the AI chat endpoint under /api/customer.
app.use("/api/shop/orders", shopOrdersRouter);

// Catch-all JSON error handler — must be registered last. Handles malformed
// JSON bodies (body-parser's SyntaxError) and any error that escaped a
// route's own try/catch, so a client only ever sees {error: "CODE"}, never
// Express's default HTML error page or a stack trace.
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "MALFORMED_JSON" });
  }
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "INTERNAL_ERROR" });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
