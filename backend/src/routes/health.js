import { Router } from "express";
import { checkDatabaseConnection } from "../db/healthCheck.js";
import { getRazorpayConfigStatus } from "../lib/payments/razorpayClient.js";

export const healthRouter = Router();

healthRouter.get("/", async (req, res) => {
  const database = await checkDatabaseConnection();

  // Pure env-presence/config checks only — never a live call to Gemini or
  // Razorpay, so this stays cheap on every health request.
  const ai = { configured: Boolean(process.env.GEMINI_API_KEY) };
  const paymentsConfigStatus = getRazorpayConfigStatus();
  const payments = {
    configured: paymentsConfigStatus.ok,
    mode: paymentsConfigStatus.ok ? "test" : "unset",
  };

  res.json({
    status: "ok",
    database,
    ai,
    payments,
  });
});
