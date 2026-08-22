import { GoogleGenAI, FunctionCallingConfigMode } from "@google/genai";

// The ONLY file in this codebase that imports a vendor AI SDK for the
// customer buyer agent. Everything else (tools.js, buyerAgent.js, the
// customer route) works purely in the neutral shapes defined here:
//   sendChat({ messages, tools, systemPrompt })
//     -> { type: "text", content }
//     -> { type: "tool_calls", calls: [{ id, name, args }], rawModelTurn }
//     -> { type: "error", code }
// Swapping vendors later means rewriting only this file.

const PROVIDER_TIMEOUT_MS = 15000;
const MAX_OUTPUT_TOKENS = 512; // keep replies concise — cheaper and free-tier friendly

let client = null;

function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

export function isProviderConfigured() {
  return Boolean(process.env.GEMINI_API_KEY) && process.env.AI_PROVIDER === "gemini";
}

// Neutral turn shapes (see buyerAgent.js) -> Gemini `contents`.
function toGeminiContents(messages) {
  const contents = [];
  for (const turn of messages) {
    if (turn.role === "user") {
      contents.push({ role: "user", parts: [{ text: turn.text }] });
    } else if (turn.role === "assistant" && turn.functionCalls) {
      // Re-send exactly what the model produced, verbatim, so the API sees a
      // consistent turn — never reconstructed by hand.
      contents.push(turn.rawModelTurn);
    } else if (turn.role === "assistant") {
      contents.push({ role: "model", parts: [{ text: turn.text || "" }] });
    } else if (turn.role === "tool") {
      contents.push({
        role: "user",
        parts: turn.responses.map((r) => ({
          functionResponse: { id: r.id, name: r.name, response: { output: r.result } },
        })),
      });
    }
  }
  return contents;
}

function toGeminiTools(toolDefinitions) {
  return [
    {
      functionDeclarations: toolDefinitions.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parametersJsonSchema,
      })),
    },
  ];
}

function classifyProviderError(error) {
  const status = error?.status;
  const message = String(error?.message || "");

  if (error?.name === "AbortError") return { type: "error", code: "TIMEOUT" };
  if (status === 401 || status === 403 || /API key/i.test(message)) return { type: "error", code: "INVALID_API_KEY" };
  if (status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(message)) return { type: "error", code: "QUOTA_EXCEEDED" };
  if (status === 404) return { type: "error", code: "MODEL_UNAVAILABLE" };
  if (/network|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(message)) return { type: "error", code: "NETWORK_ERROR" };
  return { type: "error", code: "PROVIDER_ERROR" };
}

export async function sendChat({ messages, tools, systemPrompt }) {
  const genai = getClient();
  if (!genai) {
    return { type: "error", code: "PROVIDER_UNAVAILABLE" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const response = await genai.models.generateContent({
      model: process.env.AI_MODEL,
      contents: toGeminiContents(messages),
      config: {
        systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
        tools: toGeminiTools(tools),
        // Every turn must end in a tool call, including the buyer agent's own
        // "respond_to_customer" finishing tool — this is what makes the final
        // reply arrive as structured {message, followUp} instead of free text.
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: controller.signal,
      },
    });

    const calls = response.functionCalls;
    if (calls && calls.length > 0) {
      return {
        type: "tool_calls",
        calls: calls.map((call) => ({ id: call.id, name: call.name, args: call.args || {} })),
        rawModelTurn: response.candidates?.[0]?.content,
      };
    }

    return { type: "text", content: response.text || "" };
  } catch (error) {
    return classifyProviderError(error);
  } finally {
    clearTimeout(timeout);
  }
}
