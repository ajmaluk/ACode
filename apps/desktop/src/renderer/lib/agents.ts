/**
 * ACode Agent system — the centralized definition of all agents, their
 * permissions, and their prompts.
 *
 * Every primary agent (build / plan / yolo) and every subagent
 * (general / explore / title / summary / compaction / dream / distill)
 * is declared here. Permissions are merged from a default ruleset + the
 * agent's specific ruleset.
 */
import type {
  AgentCategory,
  AgentInfo,
  AgentMode,
  PermissionAction,
  PermissionRule,
  PermissionRuleset,
  PrimaryAgentName,
} from "@acode/shared-types";

// ============================================================================
// Permission ruleset helpers (mirror ACode's permission merge logic)
// ============================================================================

/** Permission keys recognised by ACode's runtime. */
export const PERMISSIONS = [
  "*",
  "bash",
  "edit",
  "read",
  "write",
  "webfetch",
  "websearch",
  "task",
  "skill",
  "doom_loop",
  "external_directory",
  "question",
  "plan_enter",
  "plan_exit",
  "change_directory",
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number];

/**
 * Build a ruleset from a config object. The config can be:
 *   { bash: "allow" }                                   // shorthand
 *   { bash: { "git status": "allow", "*": "ask" } }    // per-pattern
 *
 * Mirrors ACode's `Permission.fromConfig` helper.
 */
export function fromConfig(config: Record<string, PermissionAction | Record<string, PermissionAction>>): PermissionRuleset {
  const rules: PermissionRuleset = [];
  for (const [permission, value] of Object.entries(config)) {
    if (typeof value === "string") {
      rules.push({ permission, pattern: "*", action: value });
    } else {
      for (const [pattern, action] of Object.entries(value)) {
        rules.push({ permission, pattern, action });
      }
    }
  }
  return rules;
}

/**
 * Merge multiple rulesets. Later rulesets override earlier ones for the same
 * (permission, pattern) pair. Wildcard patterns override specific patterns
 * at the same permission level.
 *
 * Mirrors ACode's `Permission.merge` helper.
 */
export function mergeRulesets(...rulesets: PermissionRuleset[]): PermissionRuleset {
  const merged: PermissionRuleset = [];
  for (const rs of rulesets) {
    for (const rule of rs) {
      // Remove any earlier rule that this one overrides
      const idx = merged.findIndex(
        (m) => m.permission === rule.permission && m.pattern === rule.pattern
      );
      if (idx >= 0) merged.splice(idx, 1, rule);
      else merged.push(rule);
    }
  }
  return merged;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|\\[\]/]/g, "\\$&");
  const regexStr = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp("^" + regexStr + "$");
}

/**
 * Evaluate the ruleset for a given (permission, pattern) pair. Returns the
 * effective action — falls back to the wildcard rule for that permission,
 * then the global wildcard.
 */
export function evaluate(ruleset: PermissionRuleset, permission: string, pattern: string): PermissionAction {
  for (const r of ruleset) {
    if (r.permission === permission && (r.pattern === pattern || globToRegex(r.pattern).test(pattern))) return r.action;
  }
  for (const r of ruleset) {
    if (r.permission === permission && r.pattern === "*") return r.action;
  }
  for (const r of ruleset) {
    if (r.permission === "*") return r.action;
  }
  return "ask";
}

// ============================================================================
// Bash command arity detection
// ============================================================================

/**
 * Maps a shell-command prefix to the number of tokens that define the
 * "human-understandable command". Used to identify which pattern a given
 * command should be checked against in the ruleset.
 */
const BASH_ARITY: Record<string, number> = {
  // 1-token commands
  cat: 1, cd: 1, chmod: 1, chown: 1, cp: 1, echo: 1, env: 1, export: 1,
  grep: 1, kill: 1, killall: 1, ln: 1, ls: 1, mkdir: 1, mv: 1, ps: 1,
  pwd: 1, rm: 1, rmdir: 1, sleep: 1, source: 1, tail: 1, touch: 1,
  unset: 1, which: 1, find: 1, sed: 1, awk: 1, sort: 1, uniq: 1, wc: 1,
  head: 1, diff: 1, tar: 1, zip: 1, unzip: 1, curl: 1, wget: 1,
  date: 1, whoami: 1, hostname: 1, uname: 1, df: 1, du: 1, top: 1, htop: 1,
  less: 1, more: 1, man: 1, open: 1, pbcopy: 1, pbpaste: 1,
  // 2-token commands
  "aws s3": 2, "brew install": 2, "bun install": 2, "cargo build": 2,
  "cmake build": 2, "composer require": 2, "deno run": 2, "docker run": 2,
  "firebase deploy": 2, "flyctl deploy": 2, "git add": 2, "git branch": 2,
  "git checkout": 2, "git clone": 2, "git commit": 2, "git diff": 2,
  "git fetch": 2, "git log": 2, "git merge": 2, "git pull": 2,
  "git push": 2, "git rebase": 2, "git reset": 2, "git stash": 2,
  "git switch": 2, "go build": 2,
  "gradle build": 2, "helm install": 2, "heroku logs": 2, "hugo new": 2,
  "kubectl get": 2, "kustomize build": 2, "make build": 2, "mc ls": 2,
  "minikube start": 2, "mongosh test": 2, "mysql -u": 2, "mvn compile": 2,
  "ng generate": 2, "npm install": 2, "npm run": 2, "nvm use": 2, "nx build": 2,
  "openssl genrsa": 2, "pip install": 2, "pipenv install": 2, "pnpm install": 2,
  "pnpm run": 2, "podman run": 2, "psql -d": 2, "pulumi up": 2, "pyenv install": 2,
  "python -m": 2, "rake db": 2, "rbenv install": 2, "redis-cli ping": 2,
  "rustup update": 2, "serverless invoke": 2, "skaffold dev": 2, "sls deploy": 2,
  "sst deploy": 2, "swift build": 2, "systemctl restart": 2, "terraform apply": 2,
  "tmux new": 2, "turbo run": 2, "ufw allow": 2, "vault login": 2,
  "vercel deploy": 2, "volta install": 2, "wp plugin": 2, "yarn add": 2,
  "yarn run": 2,
  // 3-token commands
  "aws s3 ls": 3, "az storage blob": 3, "bun run dev": 3, "cargo add": 3,
  "cargo run main": 3, "cdk deploy": 3, "cf push": 3, "deno task dev": 3,
  "doctl kubernetes": 3, "docker compose up": 3, "docker container ls": 3,
  "docker image prune": 3, "docker network inspect": 3, "docker volume ls": 3,
  "eksctl get clusters": 3, "eksctl create cluster": 3, "gcloud compute": 3,
  "gh pr list": 3, "git config user": 3, "git remote add": 3, "git stash pop": 3,
  "ip addr show": 3, "ip link set": 3, "ip netns exec": 3, "ip route add": 3,
  "kind create cluster": 3, "kubectl kustomize": 3, "kubectl rollout": 3,
  "mc admin info": 3, "ng generate component": 3, "npm exec vite": 3,
  "npm init vue": 3, "npm run dev": 3, "npm view react": 3, "openssl req": 3,
  "openssl x509": 3, "podman container ls": 3, "podman image prune": 3,
  "pnpm dlx create": 3, "pnpm exec vite": 3, "pnpm run dev": 3,
  "poetry add requests": 3, "pulumi stack output": 3, "sfdx force:org": 3,
  "terraform workspace": 3, "vault auth list": 3, "vault kv get": 3,
  "yarn dlx create": 3, "yarn run dev": 3,
};

/**
 * Given a full shell command like `git checkout main -b feature/x`, return
 * the canonical "human-readable" command using the arity dictionary
 * (e.g. `git checkout`). This is the pattern the ruleset will be evaluated
 * against.
 */
export function canonicaliseBashCommand(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  for (let len = Math.min(tokens.length, 5); len > 0; len--) {
    const prefix = tokens.slice(0, len).join(" ");
    if (BASH_ARITY[prefix] !== undefined) {
      return prefix;
    }
  }
  return tokens[0] ?? "";
}

// ============================================================================
// Default permission ruleset (mirrors ACode's defaults)
// ============================================================================

/**
 * The default ruleset that every ACode agent starts with. Mirrors
 * ACode's `defaults` from agent.ts.
 */
export const DEFAULT_PERMISSIONS: PermissionRuleset = fromConfig({
  "*": "allow",
  doom_loop: "ask",
  external_directory: {
    "*": "ask",
  },
  question: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
  change_directory: "ask",
});

// ============================================================================
// Primary agent definitions
// ============================================================================

const BUILD_AGENT: AgentInfo = {
  name: "build",
  category: "build",
  mode: "primary",
  native: true,
  color: "#fb8147",
  description: "Executes tools based on configured permissions.",
  permission: mergeRulesets(
    DEFAULT_PERMISSIONS,
    fromConfig({ question: "allow", plan_enter: "allow", plan_exit: "allow" })
  ),
};

const PLAN_AGENT: AgentInfo = {
  name: "plan",
  category: "plan",
  mode: "primary",
  native: true,
  color: "#c7e2a8",
  description: "Plan mode. Disallows all edit tools. Produces a plan you can review.",
  permission: mergeRulesets(
    DEFAULT_PERMISSIONS,
    fromConfig({
      question: "allow",
      plan_exit: "allow",
      edit: { "*": "deny", ".acode/plans/*.md": "allow" },
      write: { "*": "deny", ".acode/plans/*.md": "allow" },
    })
  ),
};

const YOLO_AGENT: AgentInfo = {
  name: "yolo",
  category: "build",
  mode: "primary",
  native: true,
  color: "#e85d75",
  description: "YOLO mode. Full access — reads, writes, executes everything without asking. Use with caution.",
  permission: mergeRulesets(
    DEFAULT_PERMISSIONS,
    fromConfig({ question: "allow", plan_enter: "allow", plan_exit: "allow" })
  ),
};

const GENERAL_SUBAGENT: AgentInfo = {
  name: "general",
  category: "general",
  mode: "subagent",
  native: true,
  color: "#aac4e1",
  description: "General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.",
  permission: mergeRulesets(
    DEFAULT_PERMISSIONS,
    fromConfig({ change_directory: "deny" })
  ),
};

const EXPLORE_SUBAGENT: AgentInfo = {
  name: "explore",
  category: "explore",
  mode: "subagent",
  native: true,
  color: "#f5c9b0",
  description: "Fast agent specialized for exploring codebases. Use this when you need to quickly understand a file structure, find references, or summarize a module.",
  permission: mergeRulesets(
    DEFAULT_PERMISSIONS,
    fromConfig({
      edit: "deny",
      write: "deny",
      bash: "deny",
    })
  ),
};

const TITLE_SUBAGENT: AgentInfo = {
  name: "title",
  category: "title",
  mode: "subagent",
  native: true,
  color: "#dcd7a8",
  description: "Generates a short, descriptive title for the conversation.",
  permission: fromConfig({ "*": "deny", "skill": "allow" }),
};

const SUMMARY_SUBAGENT: AgentInfo = {
  name: "summary",
  category: "summary",
  mode: "subagent",
  native: true,
  color: "#9ec1cf",
  description: "Summarizes long conversation histories into a compact form.",
  permission: fromConfig({ "*": "deny" }),
};

const COMPACTION_SUBAGENT: AgentInfo = {
  name: "compaction",
  category: "compaction",
  mode: "subagent",
  native: true,
  color: "#c4a7e7",
  description: "Compresses context to keep the conversation within model context windows.",
  permission: fromConfig({ "*": "deny" }),
};

const DREAM_SUBAGENT: AgentInfo = {
  name: "dream",
  category: "dream",
  mode: "subagent",
  native: true,
  color: "#f6c4a8",
  description: "Generates creative, exploratory code or design proposals for ambiguous tasks.",
  permission: fromConfig({ "*": "deny" }),
};

const DISTILL_SUBAGENT: AgentInfo = {
  name: "distill",
  category: "distill",
  mode: "subagent",
  native: true,
  color: "#a8c4f6",
  description: "Extracts the essential structure from a body of code or text.",
  permission: fromConfig({ "*": "deny" }),
};

export const ALL_AGENTS: AgentInfo[] = [
  BUILD_AGENT,
  PLAN_AGENT,
  YOLO_AGENT,
  GENERAL_SUBAGENT,
  EXPLORE_SUBAGENT,
  TITLE_SUBAGENT,
  SUMMARY_SUBAGENT,
  COMPACTION_SUBAGENT,
  DREAM_SUBAGENT,
  DISTILL_SUBAGENT,
];

export const PRIMARY_AGENTS: AgentInfo[] = ALL_AGENTS.filter((a) => a.mode === "primary");
export const SUBAGENTS: AgentInfo[] = ALL_AGENTS.filter((a) => a.mode === "subagent");

// Re-export from the store-friendly name (used by the Settings UI).
export const SUBAGENT_LIST: AgentInfo[] = SUBAGENTS;

export const PRIMARY_AGENT_NAMES: PrimaryAgentName[] = ["build", "plan", "yolo"];

export function getAgent(name: string): AgentInfo | undefined {
  return ALL_AGENTS.find((a) => a.name === name);
}

export function getPrimaryAgent(name: PrimaryAgentName): AgentInfo {
  const a = getAgent(name);
  if (!a) throw new Error(`Unknown primary agent: ${name}`);
  return a;
}

export function defaultAgentName(): PrimaryAgentName {
  return "build";
}

// ============================================================================
// Auto-Agent Selection — Evolver-inspired adaptive agent routing
// ============================================================================

const AGENT_SELECTION_KEY = "acode.agentSelectionHistory.v1";

interface SelectionRecord {
  prompt: string;
  agent: PrimaryAgentName;
  success: boolean;
  timestamp: number;
}

function loadSelectionHistory(): SelectionRecord[] {
  try {
    const raw = localStorage.getItem(AGENT_SELECTION_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveSelectionHistory(history: SelectionRecord[]): void {
  // Keep only last 100 records
  const trimmed = history.slice(-100);
  localStorage.setItem(AGENT_SELECTION_KEY, JSON.stringify(trimmed));
}

/**
 * Analyze a user prompt and automatically select the best agent.
 * This implements evolver-inspired adaptive agent selection with learning.
 */
export function autoSelectAgent(prompt: string, currentAgent: PrimaryAgentName): PrimaryAgentName {
  const lower = prompt.toLowerCase();

  // Check selection history for learned patterns
  const history = loadSelectionHistory();
  const learned = learnFromHistory(history, lower);
  if (learned) return learned;

  // Planning keywords → plan agent
  const planKeywords = ["plan", "design", "architect", "strategy", "approach", "analyze", "review code", "explain how", "what should", "how would you"];
  if (planKeywords.some(kw => lower.includes(kw)) && currentAgent !== "plan") {
    return "plan";
  }

  // Dangerous commands → build agent (with permissions)
  const dangerousPatterns = ["rm -rf", "sudo", "drop table", "delete all", "format disk", "git push --force"];
  if (dangerousPatterns.some(p => lower.includes(p))) {
    return "build"; // Never auto-select yolo for dangerous commands
  }

  // Simple tasks → build agent
  const simplePatterns = ["fix typo", "change color", "rename", "add comment", "format code"];
  if (simplePatterns.some(p => lower.includes(p))) {
    return "build";
  }

  // Complex multi-step → yolo agent (if user has enabled it)
  const complexPatterns = ["refactor entire", "migrate all", "rewrite from scratch", "overhaul complete"];
  if (complexPatterns.some(p => lower.includes(p))) {
    return "yolo";
  }

  // Default: keep current agent
  return currentAgent;
}

/**
 * Learn from selection history to improve future decisions.
 */
function learnFromHistory(history: SelectionRecord[], prompt: string): PrimaryAgentName | null {
  if (history.length < 5) return null;

  // Find similar past prompts and check which agent worked best
  const similar = history.filter(h => {
    const hWords = new Set(h.prompt.toLowerCase().split(/\s+/));
    const pWords = new Set(prompt.split(/\s+/));
    const intersection = [...hWords].filter(w => pWords.has(w)).length;
    return intersection >= 2; // At least 2 common words
  });

  if (similar.length < 2) return null;

  // Group by agent and calculate success rate
  const byAgent: Record<string, { success: number; total: number }> = {};
  for (const record of similar) {
    if (!byAgent[record.agent]) byAgent[record.agent] = { success: 0, total: 0 };
    byAgent[record.agent].total++;
    if (record.success) byAgent[record.agent].success++;
  }

  // Find best agent with > 60% success rate
  let bestAgent: PrimaryAgentName | null = null;
  let bestRate = 0.6;
  for (const [agent, stats] of Object.entries(byAgent)) {
    const rate = stats.total > 0 ? stats.success / stats.total : 0;
    if (rate > bestRate && stats.total >= 2 && PRIMARY_AGENT_NAMES.includes(agent as PrimaryAgentName)) {
      bestRate = rate;
      bestAgent = agent as PrimaryAgentName;
    }
  }

  return bestAgent;
}

/**
 * Record agent selection result for learning.
 */
export function recordAgentSelection(prompt: string, agent: PrimaryAgentName, success: boolean): void {
  const history = loadSelectionHistory();
  history.push({ prompt: prompt.slice(0, 200), agent, success, timestamp: Date.now() });
  saveSelectionHistory(history);
}

/**
 * Detect if a prompt needs a specific agent based on content analysis.
 */
export function detectAgentNeed(prompt: string): { agent: PrimaryAgentName; reason: string } | null {
  const lower = prompt.toLowerCase();

  // Code review detection
  if (lower.includes("review") && (lower.includes("code") || lower.includes("pr") || lower.includes("pull request"))) {
    return { agent: "plan", reason: "Code review detected" };
  }

  // Architecture/design detection
  if (lower.includes("architecture") || lower.includes("design pattern") || lower.includes("system design")) {
    return { agent: "plan", reason: "Architecture discussion detected" };
  }

  // Refactoring detection
  if (lower.includes("refactor") && (lower.includes("entire") || lower.includes("all") || lower.includes("complete"))) {
    return { agent: "yolo", reason: "Large refactoring detected" };
  }

  return null;
}
