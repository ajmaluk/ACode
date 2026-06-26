# Enhanced Implementation Plan: Self-Evolving Skill Crystallization & Advanced Memory System

This document details the architectural blueprint and implementation plan for introducing a **Nous Hermes-style self-evolving skill loop** and an **integrated workspace-wide memory management system** in Dalam.

---

## 1. System Architecture & Lifecycle Deep Dive

The crystallization lifecycle runs asynchronously off the main thread to ensure zero UI jank during active text editing.

```
[SessionEnd Event / /crystallize Command]
                 │
                 ▼
     [Session State Validation] ──(Fails Gatekeeping)──► [Silent Termination]
                 │ (Passes Gatekeeping)
                 ▼
       [Background Worker Async Thread]
                 │
                 ├──► 1. Extract Token-Truncated Chat Transcript
                 ├──► 2. Execute Structured LLM Request with JSON Schema Enforcement
                 │
                 ▼
      [JSON Parser & Schema Validator] ──(Malformatted JSON)──► [Fallback Regex / Silent Drop]
                 │ (Valid Structural Format)
                 ▼
   [State Dispatcher: Inject Dynamic Action Toast]
                 │
        ┌────────┴────────┐
        ▼                 ▼
   [On Approve]     [On Reject] ──► [Log Telemetry] ──► [Purge Memory Buffer]
        │
        ├──► 1. Write Directory Structure (.dalam/skills/[name])
        ├──► 2. Commit SKILL.md with Sanitized Frontmatter
        └──► 3. Hot-Reload Active Workspace Skills Index
```

---

## 2. Granular Data Layouts & Schema Definitions

To ensure strict data consistency across the desktop app (Tauri layer), the renderer, and local disk files, we establish runtime schemas and TypeScript interfaces.

### 2.1 File System Structure

Skills are stored inside the local project workspace configuration folder to ensure they are tracked by version control systems (`.git/`):

```text
workspace-root/
└── .dalam/
    ├── memory/
    │   └── factual_store.db      # Existing SQLite Context File
    └── skills/
        ├── configure-tailwind/
        │   └── SKILL.md          # Generated file with YAML Frontmatter
        └── setup-docker-node/
            └── SKILL.md
```

### 2.2 Core Component Types & Inter-Process Comm (`types.ts`)

```typescript
import { z } from "zod";

/**
 * Zod Schema to strictly validate LLM output at runtime before 
 * pushing it to UI components or the file system.
 */
export const SkillProposalSchema = z.object({
  shouldCrystallize: z.boolean(),
  name: z.string().regex(/^[a-z0-9](-?[a-z0-9])*$/, {
    message: "Skill name must be lowercase, alphanumeric, hyphen-delimited slugs."
  }),
  description: z.string().min(10).max(200),
  content: z.string().refine(val => val.startsWith("---") && val.includes("---"), {
    message: "Skill content must include valid markdown YAML frontmatter."
  })
});

export type SkillProposal = z.infer<typeof SkillProposalSchema>;

export interface SkillRegistryMetadata {
  id: string;               // Unique hash derived from the name slug
  name: string;             // 'configure-tailwind'
  description: string;      // Summary explanation
  localPath: string;        // Fully qualified local path to SKILL.md
  keywords: string[];       // Trigger tokens parsed from frontmatter
  createdAt: number;        // Epoch timestamp
  lastTriggeredAt?: number; // Usage monitoring data
}
```

---

## 3. Production-Ready Code Modules

### 3.1 Phase 1: Toaster Implementation with Memory Leak Prevention

We must guarantee that adding dynamic click callbacks to standard notifications does not result in memory retention issues in React state management.

#### `Toaster.tsx`

```tsx
import React from "react";
import { Toast, useToasts } from "../store/useAppStore";

export const Toaster: React.FC = () => {
  const { toasts, dismiss } = useToasts();

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 w-96 max-w-sm pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="p-4 bg-dalam-bg shadow-2xl rounded-lg border border-dalam-border flex flex-col pointer-events-auto animate-slide-in"
          role="alert"
        >
          <div className="flex justify-between items-start">
            <div>
              <h4 className="text-sm font-bold text-dalam-text-primary">{t.title}</h4>
              {t.description && <p className="text-xs text-dalam-text-secondary mt-1">{t.description}</p>}
            </div>
            <button 
              onClick={() => dismiss(t.id)} 
              className="text-xs text-dalam-text-muted hover:text-dalam-text-primary"
              aria-label="Close notification"
            >
              ✕
            </button>
          </div>
          
          {t.actions && t.actions.length > 0 && (
            <div className="flex gap-2 mt-3 justify-end pointer-events-auto">
              {t.actions.map((act) => (
                <button
                  key={`${t.id}-${act.label}`}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md shadow-sm transition-all active:scale-95 ${
                    act.variant === "primary"
                      ? "bg-dalam-accent-primary text-white hover:bg-opacity-90"
                      : act.variant === "danger"
                      ? "bg-dalam-git-deleted text-white hover:bg-opacity-90"
                      : "bg-dalam-bg-hover text-dalam-text-primary border border-dalam-border-subtle hover:bg-opacity-80"
                  }`}
                  onClick={() => {
                    act.onClick();
                    dismiss(t.id);
                  }}
                >
                  {act.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
```

### 3.2 Phase 2: Skill Crystallizer Service with Robust LLM Prompt Injection

#### `skillCrystallizer.ts`

```typescript
import { ensureDalamAPI } from "./dalamAPI";
import { useSettings, useToasts, useWorkspace } from "../store/useAppStore";
import { joinPath } from "@/lib/pathUtils";
import { SkillProposalSchema, SkillProposal } from "./types";

/**
 * Truncates chat messages contextually to avoid spilling past context limit thresholds
 */
function extractTokenOptimizedTranscript(messages: any[]): string {
  return messages
    .map(m => `[Role: ${m.role}]\n${m.content}`)
    .join("\n\n---\n\n")
    .slice(-32000); // Guard rails to capture roughly the last 6k-8k tokens maximum
}

export async function proposeSkillFromSession(sessionId: string, workspacePath: string, force = false): Promise<void> {
  const api = ensureDalamAPI();
  const store = (await import("../store/useAppStore")).useChat.getState();
  const session = store.chatSessions.find(s => s.id === sessionId);
  if (!session) return;

  const messages = session.messages || [];
  const toolsExecuted = messages.filter(m => m.role === "user" && m.content.startsWith("[TOOL RESULT")).length;
  
  if (!force && toolsExecuted < 5) return;

  const model = useSettings.getState().settings.selectedModel;
  if (!model) return;

  const cleanTranscript = extractTokenOptimizedTranscript(messages);

  const systemPrompt = `You are an advanced software engineer agent specializing in distilling software design patterns, repeatable tasks, and workspace workflows into reusable instruction files (.md).
Your goal is to look at a raw conversation history and decide if the engineering steps taken are generalizable to future sessions.`;

  const userPrompt = `Analyze the following session transcript where an assistant completed complex programming actions.
Determine if the execution strategy contains reusable code blocks, environmental setups, structural design configurations, or automation chains.

### Rules for Generation:
1. If the tasks are overly project-specific (e.g., editing a specific text value inside user 'John Doe's' custom profile), return shouldCrystallize: false.
2. If the task contains modular components (e.g., configuring Tailwind v4 with specific post-css modifications), formulate a skill.
3. The generated markdown body MUST provide generic placeholders like \`<VARIABLE_NAME>\` instead of fixed hardcoded variables.

### Output JSON Format Specification:
Return a single JSON payload adhering exactly to this TypeScript type:
{
  "shouldCrystallize": boolean,
  "name": string (must match regex /^[a-z0-9](-?[a-z0-9])*$/),
  "description": string (10 to 200 characters),
  "content": string (Complete markdown content. Must start with explicit YAML block containing 'name', 'description', and string array 'keywords')
}

Transcript data block for analysis:
---
${cleanTranscript}
---`;

  try {
    const rawResponse = await api.agent.summarizeMessages(model, [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]);

    // Clean structural syntax noise from standard LLM markdowns
    const sanitizedJSON = rawResponse.replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsedData = JSON.parse(sanitizedJSON);
    
    // Runtime Schema Validation Gate
    const validatedData: SkillProposal = SkillProposalSchema.parse(parsedData);

    if (!validatedData.shouldCrystallize) return;

    useToasts.getState().push({
      id: `crystallize-${validatedData.name}-${Date.now()}`,
      kind: "info",
      title: "✨ Micro-Skill Crystallization Detected",
      description: `Discovered extractable procedural routine: '${validatedData.name}'. Commit to workspace library?`,
      durationMs: 30000,
      actions: [
        {
          label: "Approve",
          variant: "primary",
          onClick: async () => {
            try {
              const { exists, mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
              const targetDirectory = joinPath(workspacePath, `.dalam/skills/${validatedData.name}`);
              
              if (!(await exists(targetDirectory))) {
                await mkdir(targetDirectory, { recursive: true });
              }
              
              const fileDestination = joinPath(targetDirectory, "SKILL.md");
              // Convert text to binary Uint8Array representation for native multiplatform writing layers
              const binaryBuffer = new TextEncoder().encode(validatedData.content);
              await writeFile(fileDestination, binaryBuffer);
              
              useToasts.getState().push({
                id: `success-${validatedData.name}`,
                kind: "success",
                title: "Skill Registered Successfully",
                description: `Added ${validatedData.name} context maps to your local skills system.`
              });
            } catch (err) {
              console.error("Critical Disk IO Failure saving skills metadata:", err);
            }
          }
        },
        {
          label: "Discard",
          variant: "secondary",
          onClick: () => {}
        }
      ]
    });

  } catch (validationOrNetworkError) {
    console.warn("Crystallization loop exited gracefully. Logs:", validationOrNetworkError);
  }
}
```

---

## 4. Advanced Skill Consolidation Engine (The "Dream Agent")

Over extended usage, agent runloops risk over-indexing tiny, fractured skills (e.g., `git-commit-style`, `git-commit-flow`). The **Dream Agent Service** dynamically reads disk states during long-term application idle events to run de-duplication clustering.

### Jaccard String Clustering Similarity Pipeline

```typescript
import { readDir, readFile, writeFile, remove } from "@tauri-apps/plugin-fs";
import { joinPath } from "@/lib/pathUtils";
import { ensureDalamAPI } from "./dalamAPI";

/**
 * Computes token-level intersection sets to catch surface-level duplicate structures.
 */
function calculateTokenSimilarity(textA: string, textB: string): number {
  const tokensA = new Set(textA.toLowerCase().split(/[\s,.\-\/:\(\)]+/));
  const tokensB = new Set(textB.toLowerCase().split(/[\s,.\-\/:\(\)]+/));
  
  const intersection = new Set([...tokensA].filter(x => tokensB.has(x)));
  const union = new Set([...tokensA, ...tokensB]);
  
  return intersection.size / union.size; // Returns coefficient between 0.0 and 1.0
}

export async function executeWorkspaceDreamOptimization(workspacePath: string): Promise<void> {
  const skillsPath = joinPath(workspacePath, ".dalam/skills");
  const api = ensureDalamAPI();
  
  try {
    const skillDirs = await readDir(skillsPath);
    const discoveredSkills: { name: string; rawContent: string; fullPath: string }[] = [];
    
    for (const dir of skillDirs) {
      if (!dir.isDirectory) continue;
      const fileLoc = joinPath(skillsPath, dir.name, "SKILL.md");
      const dataBytes = await readFile(fileLoc);
      const rawContent = new TextDecoder().decode(dataBytes);
      discoveredSkills.push({ name: dir.name, rawContent, fullPath: fileLoc });
    }

    // Double pointer lookup loop checking for overlapping signatures
    for (let i = 0; i < discoveredSkills.length; i++) {
      for (let j = i + 1; j < discoveredSkills.length; j++) {
        const skillA = discoveredSkills[i];
        const skillB = discoveredSkills[j];
        
        const coefficientScore = calculateTokenSimilarity(skillA.rawContent, skillB.rawContent);
        
        // Threshold triggering context merging via background LLM pass
        if (coefficientScore > 0.45) {
          const consolidationPrompt = `You are a background compilation refactoring process.
We found two highly similar, overlapping procedural instructions files inside our local project workspace configuration.
Your task is to merge these two structural documents into a single comprehensive SKILL.md document.

Skill Entry 1 [${skillA.name}]:
${skillA.rawContent}

Skill Entry 2 [${skillB.name}]:
${skillB.rawContent}

Generate an elegant unified version. Output the result in clean markdown with appropriate YAML headers.`;

          const model = "gpt-4o-mini"; // Use local/low-overhead background pricing tier models
          const response = await api.agent.summarizeMessages(model, [
            { role: "user", content: consolidationPrompt }
          ]);
          
          // Re-write consolidated results back to primary node entry point
          await writeFile(skillA.fullPath, new TextEncoder().encode(response));
          
          // Drop redundant micro-skill directories
          const oldTargetDir = joinPath(skillsPath, skillB.name);
          await remove(oldTargetDir, { recursive: true });
          
          console.log(`[Dream Worker Engine] Successfully consolidated redundant components: ${skillB.name} -> ${skillA.name}`);
          return; // Process one consolidation per idle loop to mitigate spike delays
        }
      }
    }
  } catch (emptyOrMissingDirErr) {
    // Graceful exit for cold workspaces containing zero initialized skill states
  }
}
```

---

## 5. Comprehensive Quality Verification Blueprint

To guarantee system stability, verify implementation steps against this testing trace matrix:

| Evaluation Vector | Validation Technique | Verification Assert Target | Expected Functional Result |
| --- | --- | --- | --- |
| **Zod Boundaries** | Mock LLM output payload utilizing invalid names like `Config_Tailwind!` | Code Exec Call Stack via Vitest/Jest runner | System intercepts structural layout mutations and drops processing silently before throwing unhandled runtime rejections. |
| **UI Notification Memory** | Fire `/crystallize` 10 consecutive times in chat. | Chrome DevTools Memory Profiler Heap Allocation Timelines | Clicking `Approve` or `Reject` completely releases element objects, preventing lingering pointer accumulation inside the React renderer state array. |
| **Disk Serialization** | Execute continuous automation tasks, and hit `Approve` inside toast popup UI. | Local inspection of file system target tree paths | A valid `.dalam/skills/<slug>/SKILL.md` is initialized on disk with a clean, unescaped, fully human-readable YAML configuration blocks layout. |
| **Slash Interception** | Type raw command sequence `/crystallize` directly into main pane inputs. | UI Component State Capture Logs | Bypasses standard threshold gate checks (`toolsExecuted >= 5`), signaling the AI generation stack instantly. |
