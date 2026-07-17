/**
 * ============================================================
 * DALAM SKILL CRYSTALLIZER — Self-Evolving Skill Creation
 * ============================================================
 *
 * Reflects on chat session histories at SessionEnd.
 * If a complex workflow is observed:
 *   1. Calls the LLM to generalise the steps into a reusable skill.
 *   2. Generates a SKILL.md file draft.
 *   3. Triggers an interactive user notification to Approve or Reject.
 *
 * Prevents Concept Drift and Token Bloat through gated checks and approvals.
 * ============================================================
 */

import { createDalamAPI } from "./dalamAPI";
import { useSettings } from "../store/useAppStore";
import { joinPath } from "@/lib/pathUtils";
import { loadProjectSkills, refreshProjectSkills } from "./skills";
import type { ChatMessage } from "@dalam/shared-types";

export type NotifyFn = (toast: {
  kind: "info" | "success" | "warning" | "error";
  title: string;
  description: string;
  durationMs?: number;
  actions?: Array<{
    label: string;
    variant?: "primary" | "secondary" | "danger";
    onClick: () => void;
  }>;
}) => void;

export async function proposeSkillFromSession(
  sessionId: string,
  workspacePath: string,
  force = false,
  notify: NotifyFn = (t) => {
    console.warn("[SkillCrystallizer]", t.title, t.description);
  },
): Promise<void> {
  const api = createDalamAPI();

  // Resolve active chat session history dynamically
  const { useChat } = await import("../store/useAppStore");
  const store = useChat.getState();
  const session =
    store.chatSessions.find((s) => s.id === sessionId) ||
    (store.session?.id === sessionId ? store.session : null);
  if (!session) return;

  const messages: ChatMessage[] = store.sessionMessages[sessionId] || [];

  // Count tool outputs to estimate complexity
  const toolsExecuted = messages.filter(
    (m: ChatMessage) =>
      m.role === "tool" ||
      (m.role === "user" &&
        (m.content.startsWith("[TOOL RESULT") ||
          m.content.startsWith("[TOOL ERROR"))),
  ).length;

  // Gatekeeper: only crystallize if complex or manually forced
  if (!force && toolsExecuted < 5) {
    return;
  }

  const model = useSettings.getState().settings.selectedModel;
  if (!model) return;

  const formattedHistory = messages
    .filter((m: ChatMessage) => m.role === "user" || m.role === "assistant")
    .map(
      (m: ChatMessage) =>
        `${m.role.toUpperCase()}: ${m.content.slice(0, 1000)}${m.content.length > 1000 ? "..." : ""}`,
    )
    .join("\n---\n");

  const prompt = `You are a skill crystallization assistant. Your job is to analyze this coding session transcript.
Determine if the assistant followed a reusable sequence of edits, setup steps, or commands that could be generalized into a reusable coding skill.

If yes, output a draft for a new SKILL.md file. It MUST contain:
1. YAML frontmatter containing:
   - name: lowercase-dashed-name
   - description: short summary (under 120 characters)
2. Detailed markdown body listing the procedural steps, commands, and code templates.

Format the output strictly as a JSON object:
{
  "shouldCrystallize": true,
  "name": "lowercase-dashed-name",
  "description": "Short explanation",
  "content": "---\\nname: lowercase-dashed-name\\ndescription: Short explanation\\n---...SKILL.md content..."
}
If no reusable workflow is found, return exactly:
{"shouldCrystallize": false}

Transcript:
${formattedHistory}`;

  try {
    const response = await api.agent.summarizeMessages(model, [
      {
        role: "system",
        content:
          "You are a skill crystallization assistant. Output ONLY the raw JSON object, no formatting fences.",
      },
      { role: "user", content: prompt },
    ]);

    let cleaned = response
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    // Robustly extract JSON by tracking brace depth, respecting string context
    const startIdx = cleaned.indexOf("{");
    if (startIdx !== -1) {
      let depth = 0;
      let endIdx = startIdx;
      let inString = false;
      let escapeNext = false;
      for (let i = startIdx; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (ch === "\\") {
          escapeNext = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
      if (depth !== 0) {
        console.warn(
          "[SkillCrystallizer] Unclosed braces in LLM output — skipping",
        );
        return;
      }
      cleaned = cleaned.slice(startIdx, endIdx + 1);
    }
    const data = JSON.parse(cleaned);

    // GATE 1: Syntactic validity check
    if (data.shouldCrystallize && data.name && data.content) {
      // Verify valid YAML frontmatter
      const hasValidFrontmatter = /^---\s*\n[\s\S]*?\n---\s*\n/.test(
        data.content,
      );
      if (!hasValidFrontmatter) {
        console.warn(
          "[SkillCrystallizer] Syntactic gate rejected — missing valid YAML frontmatter",
        );
        return;
      }
      // Verify required frontmatter fields
      const fmMatch = data.content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const hasName = /^name:\s*\S+/m.test(fmMatch[1]);
        const hasDescription = /^description:\s*\S+/m.test(fmMatch[1]);
        if (!hasName || !hasDescription) {
          console.warn(
            "[SkillCrystallizer] Syntactic gate rejected — frontmatter missing required fields",
          );
          return;
        }
      }
      notify({
        kind: "info",
        title: "Crystallized New Skill",
        description: `Would you like to save '${data.name}' as a project skill?`,
        durationMs: 15000,
        actions: [
          {
            label: "Approve",
            variant: "primary",
            onClick: async () => {
              try {
                const { exists, mkdir, readTextFile, readDir } =
                  await import("@tauri-apps/plugin-fs");
                // Sanitize skill name to prevent path traversal
                const safeName = data.name
                  .replace(/[^a-zA-Z0-9_-]/g, "-")
                  .replace(/-+/g, "-")
                  .replace(/^-|-$/g, "");
                if (!safeName) {
                  console.warn("[SkillCrystallizer] Sanitized skill name is empty, skipping");
                  notify({ kind: "error", title: "Invalid Name", description: "Skill name is invalid after sanitization." });
                  return;
                }
                const skillsDir = joinPath(
                  workspacePath,
                  `.dalam/skills/${safeName}`,
                );
                const skillFile = joinPath(skillsDir, "SKILL.md");

                // GATE 3: Budget enforcement — warn if over 50 skills
                try {
                  const skillsRootDir = joinPath(
                    workspacePath,
                    ".dalam/skills",
                  );
                  const allSkillEntries = await readDir(skillsRootDir);
                  if (allSkillEntries.length >= 50) {
                    notify({
                      kind: "warning",
                      title: "Skill Budget Exceeded",
                      description: `Over 50 skills detected (${allSkillEntries.length} total). Prune before adding '${data.name}'.`,
                      durationMs: 10000,
                    });
                    return;
                  }
                } catch (e) {
                  if (import.meta.env.DEV) console.warn("[SkillCrystallizer] Failed to read skills directory for budget check:", e);
                }

                // Check if skill already exists — warn user
                // GATE 2: Dedup check — same name with identical content
                if (await exists(skillFile)) {
                  const existingContent = await readTextFile(skillFile);
                  if (existingContent === data.content) {
                    notify({
                      kind: "info",
                      title: "Skill Unchanged",
                      description: `Skill '${data.name}' already exists with identical content.`,
                    });
                    return;
                  }
                  // Backup existing skill before overwrite
                  const backupDir = joinPath(skillsDir, ".backups");
                  if (!(await exists(backupDir))) {
                    await mkdir(backupDir, { recursive: true });
                  }
                  const backupFile = joinPath(
                    backupDir,
                    `backup-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.md`,
                  );
                  await api.fs.writeFile(backupFile, existingContent);
                }

                if (!(await exists(skillsDir))) {
                  await mkdir(skillsDir, { recursive: true });
                }

                // Write skill to project directory
                await api.fs.writeFile(skillFile, data.content);

                // Reload skills registry in React app state

                const projectSkills = await loadProjectSkills(
                  workspacePath,
                  api.fs,
                );
                refreshProjectSkills(projectSkills);

                notify({
                  kind: "success",
                  title: "Skill Registered",
                  description: `Skill '${data.name}' successfully added to the project registry.`,
                });
              } catch (e) {
                if (import.meta.env.DEV)
                  console.error("[SkillCrystallizer] Failed to save skill:", e);
                notify({
                  kind: "error",
                  title: "Save Failed",
                  description: "Could not write skill to disk.",
                });
              }
            },
          },
          {
            label: "Reject",
            variant: "secondary",
            onClick: () => {
              console.warn(
                `[SkillCrystallizer] Skill proposal '${data.name}' rejected by user.`,
              );
            },
          },
        ],
      });
    }
  } catch (err) {
    if (import.meta.env.DEV)
      console.error("[SkillCrystallizer] Error during crystallization:", err);
  }
}
