/**
 * ============================================================
 * DALAM LARGE INPUT HANDLER — Process Large User Pastes
 * ============================================================
 *
 * When users paste large amounts of text (e.g., entire files),
 * this module optimizes the input before sending to the agent:
 *
 * 1. Direct — Input is small enough, send as-is
 * 2. Extract — Detect file paths, extract code blocks, replace with references
 * 3. Strip — Replace large code blocks with summaries
 * 4. Truncate — Hard limit as last resort
 *
 * This prevents context overflow and wasted tokens.
 * ============================================================
 */

import { countTokens } from "./tokenizer";

const MAX_DIRECT_TOKENS = 4_000;
const MAX_TOTAL_TOKENS = 50_000;


export interface LargeInputResult {
  processedContent: string;
  estimatedTokens: number;
  warnings: string[];
  extractedFiles: ExtractedFile[];
  wasTruncated: boolean;
  originalSize: number;
  strategy: "direct" | "extract" | "strip" | "truncate";
}

export interface ExtractedFile {
  path: string;
  content: string;
  tokenCount: number;
  wasTruncated: boolean;
}

/**
 * Process large user input before sending to the agent.
 * Applies strategies in order: direct → extract → strip → truncate.
 */
export async function processLargeInput(
  rawInput: string,
  model: string,
): Promise<LargeInputResult> {
  const warnings: string[] = [];
  const extractedFiles: ExtractedFile[] = [];
  const originalSize = rawInput.length;
  let content = rawInput;

  // ── Step 1: Token count check ──
  const inputTokens = countTokens(content, model);
  if (inputTokens <= MAX_DIRECT_TOKENS) {
    return {
      processedContent: content,
      estimatedTokens: inputTokens,
      warnings: [],
      extractedFiles: [],
      wasTruncated: false,
      originalSize,
      strategy: "direct",
    };
  }

  // ── Step 2: Strip large code blocks ──
  content = stripLargeCodeBlocks(content, model);
  const afterStripTokens = countTokens(content, model);

  if (afterStripTokens <= MAX_DIRECT_TOKENS) {
    return {
      processedContent: content,
      estimatedTokens: afterStripTokens,
      warnings: ["Large code blocks were replaced with summaries"],
      extractedFiles,
      wasTruncated: true,
      originalSize,
      strategy: "strip",
    };
  }

  // ── Step 3: Hard truncation as last resort ──
  if (afterStripTokens > MAX_TOTAL_TOKENS) {
    content = truncatePreservingStructure(content, MAX_TOTAL_TOKENS, model);
    warnings.push(
      `Input exceeded ${MAX_TOTAL_TOKENS.toLocaleString()} tokens and was truncated. ` +
        "Consider using file references instead of pasting entire files.",
    );
  }

  return {
    processedContent: content,
    estimatedTokens: countTokens(content, model),
    warnings,
    extractedFiles,
    wasTruncated: true,
    originalSize,
    strategy: "truncate",
  };
}

/**
 * Strip large code blocks, replacing them with brief previews.
 */
function stripLargeCodeBlocks(content: string, model: string): string {
  return content.replace(/```[\s\S]*?```/g, (block) => {
    const tokens = countTokens(block, model);
    if (tokens > MAX_DIRECT_TOKENS) {
      const lines = block.split("\n");
      const lang = lines[0].match(/```(\w+)/)?.[1] || "";
      const first5 = lines.slice(1, 6).join("\n");
      return `\`\`\`${lang}\n${first5}\n// ... ${lines.length - 7} lines omitted ...\n\`\`\``;
    }
    return block;
  });
}

/**
 * Truncate text while preserving structural elements
 * (imports, function signatures, headings, brackets).
 */
function truncatePreservingStructure(
  text: string,
  maxTokens: number,
  model: string,
): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let currentTokens = 0;

  for (const line of lines) {
    const lineTokens = countTokens(line, model);

    // Always keep important structural lines
    const isStructural =
      /^\s*(import|export|from|require|package|use|#include)/.test(line) ||
      /^\s*(function|class|interface|type|enum|const|let|var|def|fn|pub)/.test(
        line,
      ) ||
      /^\s*(\/\/|\/\*|\*|#|<!--)/.test(line) ||
      /^\s*[{}()[\]]/.test(line) ||
      /^#{1,6}\s/.test(line) ||
      line.trim() === "";

    if (currentTokens + lineTokens > maxTokens && !isStructural) {
      continue; // Skip non-structural lines when over budget
    }

    result.push(line);
    currentTokens += lineTokens;

    if (currentTokens >= maxTokens) break;
  }

  return result.join("\n");
}

