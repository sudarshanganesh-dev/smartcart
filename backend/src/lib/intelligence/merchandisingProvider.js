import { GoogleGenAI, Type } from "@google/genai";
import { MERCHANDISING_SYSTEM_PROMPT, buildMerchandisingUserPrompt } from "./merchandisingPrompt.js";

// The ONLY file that imports a vendor AI SDK for merchant intelligence —
// mirrors ai/buyer/provider.js's isolation, kept entirely separate so
// swapping/tuning one never risks the other. Decision 5: the response
// schema deliberately has NO price field — Gemini is structurally unable to
// supply one, since it's not part of the contract at all.

const PROVIDER_TIMEOUT_MS = 15000;
const MAX_OUTPUT_TOKENS = 512;

let client = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    type: { type: Type.STRING, enum: ["BUNDLE", "VARIANT"] },
    name: { type: Type.STRING },
    description: { type: Type.STRING },
    componentProductIds: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["type", "name", "description", "componentProductIds"],
};

// Returns { proposal } on success, or { error } — the caller (opportunityService)
// treats every field of `proposal` as untrusted input and re-validates it
// against real trusted data before anything is ever written.
export async function proposeMerchandisingAction({ opportunitySummary, candidateProducts }) {
  const genai = getClient();
  if (!genai) return { error: "PROVIDER_UNAVAILABLE" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const response = await genai.models.generateContent({
      model: process.env.AI_MODEL,
      contents: [{ role: "user", parts: [{ text: buildMerchandisingUserPrompt({ opportunitySummary, candidateProducts }) }] }],
      config: {
        systemInstruction: { role: "system", parts: [{ text: MERCHANDISING_SYSTEM_PROMPT }] },
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: controller.signal,
      },
    });

    const text = response.text;
    if (!text) return { error: "EMPTY_RESPONSE" };

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { error: "INVALID_JSON" };
    }
    return { proposal: parsed };
  } catch (error) {
    console.error("[merchandising-provider] proposal failed:", error.message);
    return { error: "PROVIDER_ERROR" };
  } finally {
    clearTimeout(timeout);
  }
}
