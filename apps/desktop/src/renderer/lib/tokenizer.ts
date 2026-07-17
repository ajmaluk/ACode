/**
 * ============================================================
 * DALAM TOKENIZER — Real Token Counting
 * ============================================================
 *
 * Uses js-tiktoken for accurate OpenAI token counts.
 * Anthropic models use a 0.9x approximation of cl100k_base.
 * Falls back to character heuristics if tiktoken fails.
 *
 * Also provides TokenBudget computation for context management.
 * ============================================================
 */

import { encodingForModel } from "js-tiktoken";

// Lazy-loaded encoder instances (different models use different encodings)
let cl100kEncoder: ReturnType<typeof encodingForModel> | null = null;
let o200kEncoder: ReturnType<typeof encodingForModel> | null = null;

function getEncoder(model: string) {
  // GPT-4o family uses o200k_base
  if (
    model.includes("gpt-4o") ||
    model.includes("gpt-4-mini") ||
    model.includes("o1") ||
    model.includes("o3")
  ) {
    if (!o200kEncoder) {
      o200kEncoder = encodingForModel("gpt-4o");
    }
    return o200kEncoder;
  }

  // Default to cl100k_base (GPT-4, GPT-3.5, most OpenAI models)
  if (!cl100kEncoder) {
    cl100kEncoder = encodingForModel("gpt-4");
  }
  return cl100kEncoder;
}

// Anthropic doesn't have a public tokenizer, use approximation
// Their tokenizer is close to cl100k but ~10% fewer tokens
function estimateAnthropicTokens(text: string): number {
  if (!cl100kEncoder) {
    cl100kEncoder = encodingForModel("gpt-4");
  }
  const openaiCount = cl100kEncoder.encode(text).length;
  return Math.ceil(openaiCount * 0.9);
}

/**
 * Count tokens in a text string using the appropriate encoder for the model.
 */
export function countTokens(text: string, model: string): number {
  if (!text) return 0;

  try {
    if (model.includes("claude")) {
      return estimateAnthropicTokens(text);
    }

    const encoder = getEncoder(model);
    return encoder.encode(text).length;
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Tokenizer] tiktoken failed, falling back to heuristic:", e);
    return heuristicTokenCount(text);
  }
}

/**
 * Count tokens across an array of messages, accounting for OpenAI message formatting overhead.
 */
export function countMessageTokens(
  messages: Array<{ role: string; content: string }>,
  model: string,
): number {
  let total = 0;
  for (const msg of messages) {
    // OpenAI format overhead per message
    total += 4; // <|start|>{role}\n{content}<|end|>\n
    total += countTokens(msg.content, model);
    if (msg.role === "tool") {
      total += 8; // tool call formatting overhead
    }
  }
  total += 2; // <|start|>assistant
  return total;
}

/**
 * Heuristic token count as fallback when tiktoken is unavailable.
 * Reasonably accurate for English text and code.
 */
function heuristicTokenCount(text: string): number {
  let count = 0;
  // CJK characters
  const cjk = text.match(
    /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g,
  );
  if (cjk) count += cjk.length * 0.6;
  // Remove CJK for latin counting
  const latin = text.replace(
    /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g,
    "",
  );
  count += latin.length / 3.8;
  return Math.ceil(count);
}

// ─── Token Budget ────────────────────────────────────────────

export interface TokenBudget {
  total: number; // Model's context window
  systemPrompt: number; // System prompt + tools + instructions
  conversation: number; // Chat messages
  toolResults: number; // Tool output in messages
  available: number; // Remaining for new content
  pressure: "none" | "low" | "medium" | "high" | "critical";
}

/**
 * Compute the token budget for the current conversation state.
 * Used to determine when context compaction should trigger.
 */
export function computeTokenBudget(
  messages: Array<{ role: string; content: string }>,
  systemPromptTokens: number,
  modelContextWindow: number,
  model: string,
): TokenBudget {
  const nonToolMessages = messages.filter((m) => m.role !== "tool");
  const conversationTokens = countMessageTokens(nonToolMessages, model);
  const toolResultTokens = messages
    .filter((m) => m.role === "tool")
    .reduce((sum, m) => sum + countTokens(m.content, model), 0);

  const used = systemPromptTokens + conversationTokens;
  const available = modelContextWindow - used;
  const usageRatio = used / modelContextWindow;

  let pressure: TokenBudget["pressure"];
  if (usageRatio < 0.5) pressure = "none";
  else if (usageRatio < 0.65) pressure = "low";
  else if (usageRatio < 0.8) pressure = "medium";
  else if (usageRatio < 0.9) pressure = "high";
  else pressure = "critical";

  return {
    total: modelContextWindow,
    systemPrompt: systemPromptTokens,
    conversation: conversationTokens,
    toolResults: toolResultTokens,
    available,
    pressure,
  };
}
