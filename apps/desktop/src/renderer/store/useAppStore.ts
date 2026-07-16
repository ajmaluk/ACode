// ============================================================================
// Barrel file — re-exports all store hooks, types, and utilities from the
// individual store modules. Maintains backward compatibility for all code that
// imports from "@/store/useAppStore".
// ============================================================================

// Re-exports from external libs (preserved from original useAppStore.ts)
export { ALL_AGENTS, PRIMARY_AGENTS, SUBAGENTS, getPrimaryAgent } from "@/lib/agents";
export { BUNDLED_SKILLS, skillRegistry, matchSkillInvocation, renderSkillForPrompt } from "@/lib/skills";
export { exportTrajectories, getTrajectoryStats } from "@/lib/trajectoryRecorder";

// These types were re-exported from the original useAppStore.ts
import type { AgentInfo, AgentMode, PermissionAction, PermissionRule, PrimaryAgentName, SkillInfo, FileAttachment } from "@dalam/shared-types";
export type { AgentInfo, AgentMode, PermissionAction, PermissionRule, PrimaryAgentName, SkillInfo, FileAttachment };

// Store hooks
export { useCommandPalette } from "./useCommandPalette";
export { useSettings } from "./useSettings";
export { useWorkspace } from "./useWorkspace";
export type { OpenTab } from "./useWorkspace";
export { useGit } from "./useGit";
export { useAgents } from "./useAgents";
export { useChat } from "./useChat";
export { useTerminal } from "./useTerminal";
export { useSkillsMcp } from "./useSkillsMcp";
export { useModelProviders } from "./useModelProviders";
export type { ModelProvider, SettingsTab } from "./useModelProviders";
export { useSettingsView } from "./useSettingsView";
export { useShortcuts } from "./useShortcuts";
export { useUI } from "./useUI";
export { usePermission, _toolCallResolvers, _pendingResolutions, withPermission } from "./usePermission";
export type { PermissionKind, PermissionRequest } from "./usePermission";
export { useQuestion } from "./useQuestion";
export { useDiffView } from "./useDiffView";

// XML tool call utilities
export { stripXmlToolCallTags, parseXmlToolCalls, stripInlineXml, resetStreamingState } from "./xmlParser";

// Persistence utilities
export {
  loadPersistedWorkspaces,
  savePersistedWorkspaces,
  initWorkspaceMemory,
  loadPersistedMessages,
  savePersistedMessages,
  savePersistedMessagesImmediate,
  loadPersistedAgents,
  savePersistedAgents,
  loadPersistedVersions,
  savePersistedVersions,
  loadPersistedSessionSummaries,
  savePersistedSessionSummaries,
  loadPersistedCompactionSummaries,
  savePersistedCompactionSummaries,
  loadEnabledSkills,
  saveEnabledSkills,
  saveWorkspaceData,
  flushSaveWorkspaceData,
} from "./persistence";

export { loadMcpServers } from "./useSkillsMcp";
export { loadWorkspaceConfigAndSessions } from "./useWorkspace";

// Browser utilities
export type { BrowserTab } from "./browserUtils";
