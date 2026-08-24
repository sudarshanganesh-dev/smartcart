import rateLimit from "express-rate-limit";

// Phase 6 hardening: minimal in-memory rate limiting for the high-cost/
// high-risk POST endpoints only (chat → Gemini, checkout → Razorpay,
// crawl/upload → expensive server-side work). GET catalog/order endpoints
// are deliberately never limited.
//
// Local development and the Buildathon demo must never be accidentally
// throttled: limiting is enforced only when NODE_ENV=production. Set
// FORCE_RATE_LIMIT=1 to exercise the 429 path locally without flipping
// NODE_ENV (used for Phase 6 verification testing).
const bypassed = process.env.NODE_ENV !== "production" && process.env.FORCE_RATE_LIMIT !== "1";

function createLimiter({ windowMs, max, code }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => bypassed,
    handler: (req, res) => {
      res.status(429).json({ error: code });
    },
  });
}

export const chatLimiter = createLimiter({ windowMs: 60_000, max: 20, code: "CHAT_RATE_LIMIT_EXCEEDED" });
export const checkoutLimiter = createLimiter({ windowMs: 60_000, max: 10, code: "CHECKOUT_RATE_LIMIT_EXCEEDED" });
export const crawlLimiter = createLimiter({ windowMs: 60_000, max: 5, code: "CRAWL_RATE_LIMIT_EXCEEDED" });
export const uploadLimiter = createLimiter({ windowMs: 60_000, max: 10, code: "UPLOAD_RATE_LIMIT_EXCEEDED" });
// Phase 7: generate-draft is a Gemini call + a write, same cost class as
// crawl/upload.
export const generateDraftLimiter = createLimiter({ windowMs: 60_000, max: 10, code: "GENERATE_DRAFT_RATE_LIMIT_EXCEEDED" });
