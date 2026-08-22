import { Router } from "express";
import { handleMessage } from "../lib/ai/buyer/buyerAgent.js";

export const customerRouter = Router();

customerRouter.post("/chat", async (req, res) => {
  const { conversationId, message } = req.body || {};

  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "INVALID_MESSAGE" });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: "MESSAGE_TOO_LONG" });
  }

  try {
    const result = await handleMessage(typeof conversationId === "string" ? conversationId : undefined, message.trim());
    res.json({
      conversationId: result.conversationId,
      message: result.message,
      products: result.products,
      followUp: result.followUp,
      cart: result.cart,
    });
  } catch (error) {
    console.error("Customer chat failed:", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
