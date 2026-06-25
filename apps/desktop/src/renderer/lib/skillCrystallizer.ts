/**
 * ============================================================
 * ACODE SKILL CRYSTALLIZER — Self-Evolving Skill Creation
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

import { ensureAcodeAPI } from "./acodeAPI";
import { useSettings } from "../store/useAppStore";
import { joinPath } from "@/lib/pathUtils";
import type { ChatMessage } from "@acode/shared-types";

export type NotifyFn = (toast: { kind: "info" | "success" | "warning" | "error"; title: string; description: string; durationMs?: number; actions?: Array<{ label: string; variant?: "primary" | "secondary" | "danger"; onClick: () => void }> }) => void;

export async function proposeSkillFromSession(sessionId: string, workspacePath: string, force = false, notify: NotifyFn = (t) => { console.warn("[SkillCrystallizer]", t.title, t.description); }): Promise<void> {
  const api = ensureAcodeAPI();
  
  // Resolve active chat session history dynamically
  const { useChat } = await import("../store/useAppStore");
  const store = useChat.getState();
  const session = store.chatSessions.find((s) => s.id === sessionId) || (store.session?.id === sessionId ? store.session : null);
  if (!session) return;

  const messages: ChatMessage[] = store.sessionMessages[sessionId] || [];
  
  // Count tool outputs to estimate complexity
  const toolsExecuted = messages.filter((m: ChatMessage) => m.role === "user" && (m.content.startsWith("[TOOL RESULT") || m.content.startsWith("[TOOL ERROR"))).length;

  // Gatekeeper: only crystallize if complex or manually forced
  if (!force && toolsExecuted < 5) {
    return;
  }

  const model = useSettings.getState().settings.selectedModel;
  if (!model) return;

  const formattedHistory = messages
    .filter((m: ChatMessage) => m.role === "user" || m.role === "assistant")
    .map((m: ChatMessage) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1000)}${m.content.length > 1000 ? "..." : ""}`)
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
      { role: "system", content: "You are a skill crystallization assistant. Output ONLY the raw JSON object, no formatting fences." },
      { role: "user", content: prompt }
    ]);

    let cleaned = response.replace(/```json/gi, "").replace(/```/g, "").trim();
    const startIdx = cleaned.indexOf("{");
    const endIdx = cleaned.lastIndexOf("}");
    if (startIdx !== -1 && endIdx !== -1) {
      cleaned = cleaned.slice(startIdx, endIdx + 1);
    }
    const data = JSON.parse(cleaned);

    if (data.shouldCrystallize && data.name && data.content) {
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
                const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
                const skillsDir = joinPath(workspacePath, `.acode/skills/${data.name}`);
                if (!(await exists(skillsDir))) {
                  await mkdir(skillsDir, { recursive: true });
                }
                
                // Write skill to project directory
                await api.fs.writeFile(joinPath(skillsDir, "SKILL.md"), data.content);

                // Reload skills registry in React app state
                const { loadProjectSkills, refreshProjectSkills } = await import("./skills");
                const projectSkills = await loadProjectSkills(workspacePath, api.fs);
                refreshProjectSkills(projectSkills);

                notify({
                  kind: "success",
                  title: "Skill Registered",
                  description: `Skill '${data.name}' successfully added to the project registry.`
                });
              } catch (e) {
                console.error("[SkillCrystallizer] Failed to save skill:", e);
                notify({
                  kind: "error",
                  title: "Save Failed",
                  description: "Could not write skill to disk."
                });
              }
            }
          },
          {
            label: "Reject",
            variant: "secondary",
              onClick: () => {
                console.warn(`[SkillCrystallizer] Skill proposal '${data.name}' rejected by user.`);
              }
          }
        ]
      });
    }
  } catch (err) {
    console.error("[SkillCrystallizer] Error during crystallization:", err);
  }
}
