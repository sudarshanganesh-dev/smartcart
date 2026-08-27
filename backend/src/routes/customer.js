import { Router } from "express";
import { handleMessage, addBundleToCartForConversation, addProductToCartForConversation } from "../lib/ai/buyer/buyerAgent.js";

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
      bundle: result.bundle,
      followUp: result.followUp,
      cart: result.cart,
      checkoutReady: result.checkoutReady,
    });
  } catch (error) {
    console.error("Customer chat failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// Deterministic "Add all to cart" action for a SmartCart Plan (internal name:
// bundle) — a dedicated button/endpoint outside the chat loop, the same way
// "Proceed to payment" is, and for the same reason: never let a multi-item
// mutation depend on anything Gemini said. Re-validates and applies
// atomically (all-or-nothing) inside addBundleToCartForConversation.
customerRouter.post("/bundle/add-all", async (req, res) => {
  const { conversationId } = req.body || {};

  if (typeof conversationId !== "string" || conversationId.trim() === "") {
    return res.status(400).json({ error: "INVALID_CONVERSATION" });
  }

  try {
    const result = await addBundleToCartForConversation(conversationId);
    if (result.error === "UNKNOWN_CONVERSATION") {
      return res.status(404).json({ error: "UNKNOWN_CONVERSATION" });
    }
    if (result.error === "NO_ACTIVE_PLAN") {
      return res.status(409).json({ error: "NO_ACTIVE_PLAN" });
    }
    if (result.error === "PLAN_ITEM_INVALID") {
      return res.status(409).json({ error: "PLAN_ITEM_INVALID", blockers: result.blockers, cart: result.cart });
    }
    res.json({ cart: result.cart });
  } catch (error) {
    console.error("Add plan to cart failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// Deterministic "Add to cart" action for a single product card — a direct,
// visible commerce action alongside conversational ordering, never a
// replacement for it. Delegates entirely to addProductToCartForConversation,
// which reuses the SAME cart executor/grounding rule the conversational
// add_to_cart tool call already goes through — no parallel validation here.
customerRouter.post("/cart/add", async (req, res) => {
  const { conversationId, productId } = req.body || {};

  if (typeof conversationId !== "string" || conversationId.trim() === "") {
    return res.status(400).json({ error: "INVALID_CONVERSATION" });
  }
  if (typeof productId !== "string" || productId.trim() === "") {
    return res.status(400).json({ error: "INVALID_ARGUMENTS" });
  }

  try {
    const result = await addProductToCartForConversation(conversationId, productId);
    if (result.error === "UNKNOWN_CONVERSATION") {
      return res.status(404).json({ error: "UNKNOWN_CONVERSATION" });
    }
    if (result.error) {
      return res.status(409).json({ error: result.error, message: result.message });
    }
    res.json({ cart: result.cart });
  } catch (error) {
    console.error("Add to cart failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
