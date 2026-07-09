/**
 * Dalam Agent system — the centralized definition of all agents, their
 * permissions, and their prompts.
 *
 * Every primary agent (build / plan / yolo) and every subagent
 * (general / explore / title / summary / compaction / dream / distill)
 * is declared here. Permissions are merged from a default ruleset + the
 * agent's specific ruleset.
 */
import type {
  AgentInfo,
  PermissionAction,
  PermissionRuleset,
  PrimaryAgentName,
} from "@dalam/shared-types";

// ============================================================================
// Permission ruleset helpers (mirror Dalam's permission merge logic)
// ============================================================================

/** Permission keys recognised by Dalam's runtime. */
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
  "mcp",
  "doom_loop",
  "external_directory",
  "question",
  "change_directory",
] as const;

/**
 * Build a ruleset from a config object. The config can be:
 *   { bash: "allow" }                                   // shorthand
 *   { bash: { "git status": "allow", "*": "ask" } }    // per-pattern
 *
 * Mirrors Dalam's `Permission.fromConfig` helper.
 */
export function fromConfig(
  config: Record<string, PermissionAction | Record<string, PermissionAction>>,
): PermissionRuleset {
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
 * Mirrors Dalam's `Permission.merge` helper.
 */
export function mergeRulesets(
  ...rulesets: PermissionRuleset[]
): PermissionRuleset {
  const merged: PermissionRuleset = [];
  for (const rs of rulesets) {
    for (const rule of rs) {
      const idx = merged.findIndex(
        (m) => m.permission === rule.permission && m.pattern === rule.pattern,
      );
      if (idx >= 0) merged.splice(idx, 1, rule);
      else merged.push(rule);
    }
  }
  return merged;
}

const _globRegexCache = new Map<string, RegExp>();
const MAX_GLOB_CACHE = 500;
function globToRegex(pattern: string): RegExp {
  const cached = _globRegexCache.get(pattern);
  if (cached) return cached;
  // Evict oldest entries if at cap
  if (_globRegexCache.size >= MAX_GLOB_CACHE) {
    const firstKey = _globRegexCache.keys().next().value;
    if (firstKey !== undefined) _globRegexCache.delete(firstKey);
  }
  // Step 1: Extract brace groups and replace with placeholders to avoid double-escaping
  const braceGroups: string[] = [];
  // Use sentinel strings (not control characters) to avoid eslint no-control-regex
  let expanded = pattern.replace(/\{([^}]+)\}/g, (_, group: string) => {
    const parts = group
      .split(",")
      .map((s) => s.trim().replace(/[.+^${}()|\\[\]/]/g, "\\$&"));
    const result = "(?:" + parts.join("|") + ")";
    braceGroups.push(result);
    return `__BRACE${braceGroups.length - 1}__`;
  });
  // Step 2: Escape remaining glob special chars (but not our placeholders)
  expanded = expanded.replace(/[.+^$()|\\[\]/]/g, "\\$&");
  // Step 3: Convert glob patterns
  const regexStr = expanded
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, ".*")
    .replace(/\?/g, "[^/]")
    .replace(/__GLOBSTAR__/g, ".*")
    // Step 4: Restore brace groups
    .replace(/__BRACE(\d+)__/g, (_, idx) => braceGroups[parseInt(idx)] || "");
  const regex = new RegExp("^" + regexStr + "$");
  _globRegexCache.set(pattern, regex);
  return regex;
}

/**
 * Evaluate the ruleset for a given (permission, pattern) pair. Returns the
 * effective action — falls back to the wildcard rule for that permission,
 * then the global wildcard.
 *
 * Optimized: single pass with three tracking variables instead of 3 linear scans.
 */
export function evaluate(
  ruleset: PermissionRuleset,
  permission: string,
  pattern: string,
): PermissionAction {
  let permissionWildcard: PermissionAction | undefined;
  let globalWildcard: PermissionAction | undefined;

  // First pass: exact match (highest priority, bypasses ordering issues)
  for (const r of ruleset) {
    if (r.permission === permission && r.pattern === pattern) {
      return r.action;
    }
  }

  // Second pass: glob match + wildcard tracking
  for (const r of ruleset) {
    if (r.permission === permission) {
      if (r.pattern === "*") {
        permissionWildcard = r.action;
      } else if (r.pattern !== pattern && globToRegex(r.pattern).test(pattern)) {
        return r.action;
      }
    } else if (r.permission === "*") {
      globalWildcard = r.action;
    }
  }

  return permissionWildcard ?? globalWildcard ?? "ask";
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
  // 1-token Unix commands
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  export: 1,
  grep: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  source: 1,
  tail: 1,
  touch: 1,
  unset: 1,
  which: 1,
  find: 1,
  sed: 1,
  awk: 1,
  sort: 1,
  uniq: 1,
  wc: 1,
  head: 1,
  diff: 1,
  tar: 1,
  zip: 1,
  unzip: 1,
  curl: 1,
  wget: 1,
  date: 1,
  whoami: 1,
  hostname: 1,
  uname: 1,
  df: 1,
  du: 1,
  top: 1,
  htop: 1,
  less: 1,
  more: 1,
  man: 1,
  open: 1,
  pbcopy: 1,
  pbpaste: 1,
  dir: 1,
  cls: 1,
  copy: 1,
  move: 1,
  del: 1,
  ren: 1,
  type: 1,
  ipconfig: 1,
  tasklist: 1,
  taskkill: 1,
  netstat: 1,
  systeminfo: 1,
  set: 1,
  ver: 1,
  chdir: 1,
  popd: 1,
  pushd: 1,
  "aws s3": 2,
  "brew install": 2,
  "bun install": 2,
  "cargo build": 2,
  "cmake build": 2,
  "composer require": 2,
  "deno run": 2,
  "docker run": 2,
  "firebase deploy": 2,
  "flyctl deploy": 2,
  "git add": 2,
  "git branch": 2,
  "git checkout": 2,
  "git clone": 2,
  "git commit": 2,
  "git diff": 2,
  "git fetch": 2,
  "git log": 2,
  "git merge": 2,
  "git pull": 2,
  "git push": 2,
  "git rebase": 2,
  "git reset": 2,
  "git status": 2,
  "git stash": 2,
  "git switch": 2,
  "go build": 2,
  "gradle build": 2,
  "helm install": 2,
  "heroku logs": 2,
  "hugo new": 2,
  "kubectl get": 2,
  "kustomize build": 2,
  "make build": 2,
  "mc ls": 2,
  "minikube start": 2,
  "mongosh test": 2,
  "mysql -u": 2,
  "mvn compile": 2,
  "ng generate": 2,
  "npm install": 2,
  "npm run": 2,
  "nvm use": 2,
  "nx build": 2,
  "openssl genrsa": 2,
  "pip install": 2,
  "pipenv install": 2,
  "pnpm install": 2,
  "pnpm run": 2,
  "podman run": 2,
  "psql -d": 2,
  "pulumi up": 2,
  "pyenv install": 2,
  "python -m": 2,
  "rake db": 2,
  "rbenv install": 2,
  "redis-cli ping": 2,
  "rustup update": 2,
  "serverless invoke": 2,
  "skaffold dev": 2,
  "sls deploy": 2,
  "sst deploy": 2,
  "swift build": 2,
  "systemctl restart": 2,
  "terraform apply": 2,
  "tmux new": 2,
  "turbo run": 2,
  "ufw allow": 2,
  "vault login": 2,
  "vercel deploy": 2,
  "volta install": 2,
  "wp plugin": 2,
  "yarn add": 2,
  "yarn run": 2,
  "aws s3 ls": 3,
  "az storage blob": 3,
  "bun run dev": 3,
  "cargo add": 3,
  "cargo run main": 3,
  "cdk deploy": 3,
  "cf push": 3,
  "deno task dev": 3,
  "doctl kubernetes": 3,
  "docker compose up": 3,
  "docker container ls": 3,
  "docker image prune": 3,
  "docker network inspect": 3,
  "docker volume ls": 3,
  "eksctl get clusters": 3,
  "eksctl create cluster": 3,
  "gcloud compute": 3,
  "gh pr list": 3,
  "git config user": 3,
  "git remote add": 3,
  "git stash pop": 3,
  "ip addr show": 3,
  "ip link set": 3,
  "ip netns exec": 3,
  "ip route add": 3,
  "kind create cluster": 3,
  "kubectl kustomize": 3,
  "kubectl rollout": 3,
  "mc admin info": 3,
  "ng generate component": 3,
  "npm exec vite": 3,
  "npm init vue": 3,
  "npm run dev": 3,
  "npm view react": 3,
  "openssl req": 3,
  "openssl x509": 3,
  "podman container ls": 3,
  "podman image prune": 3,
  "pnpm dlx create": 3,
  "pnpm exec vite": 3,
  "pnpm run dev": 3,
  "poetry add requests": 3,
  "pulumi stack output": 3,
  "sfdx force:org": 3,
  "terraform workspace": 3,
  "vault auth list": 3,
  "vault kv get": 3,
  "yarn dlx create": 3,
  "yarn run dev": 3,
};

/**
 * Check if a shell command contains shell metacharacters that could bypass
 * arity-based permission detection. Metacharacters like |, ;, &&, ||, `, $()
 * let hidden commands execute that aren't visible to arity analysis.
 */
const SHELL_METACHARACTERS = /[|;`$]|&&|\|\|/;
const SHELL_REDIRECT = /[<>]/;
export function hasShellMetacharacters(command: string): boolean {
  return SHELL_METACHARACTERS.test(command) || SHELL_REDIRECT.test(command);
}

/**
 * Given a full shell command like `git checkout main -b feature/x`, return
 * the canonical "human-readable" command using the arity dictionary
 * (e.g. `git checkout`). This is the pattern the ruleset will be evaluated
 * against.
 * If the command contains shell metacharacters (|, ;, &&, `, $()), append a
 * marker so the pattern doesn't match any allow rules (forcing "ask").
 */
export function canonicaliseBashCommand(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const hasMetachars = tokens.length > 0 && hasShellMetacharacters(command);
  for (let len = Math.min(tokens.length, 5); len > 0; len--) {
    const prefix = tokens.slice(0, len).join(" ");
    if (BASH_ARITY[prefix] !== undefined) {
      return hasMetachars ? `${prefix} |` : prefix;
    }
  }
  const first = tokens[0] ?? "";
  return hasMetachars && first ? `${first} |` : first;
}

// ============================================================================
// Default permission ruleset (mirrors Dalam's defaults)
// ============================================================================

/**
 * The default ruleset that every Dalam agent starts with. Mirrors
 * Dalam's `defaults` from agent.ts.
 */
export const DEFAULT_PERMISSIONS: PermissionRuleset = fromConfig({
  "*": "ask",
  mcp: "ask",
  doom_loop: "ask",
  external_directory: {
    "*": "ask",
  },
  question: "allow",
  change_directory: "ask",
});

// ============================================================================
// Primary agent definitions
// ============================================================================

const YOLO_AGENT: AgentInfo = {
  name: "yolo",
  category: "general",
  mode: "primary",
  native: true,
  color: "#e85d75",
  icon: "zap",
  description:
    "Full unrestricted access — reads, writes, executes everything without asking. Use for experienced users who want maximum speed.",
  permission: mergeRulesets(
    DEFAULT_PERMISSIONS,
    fromConfig({
      "*": "allow",
      question: "allow",
      doom_loop: "allow",
      external_directory: "allow",
      change_directory: "allow",
    }),
  ),
};

const BUILD_AGENT: AgentInfo = {
  name: "build",
  category: "general",
  mode: "primary",
  native: true,
  color: "#81c784",
  icon: "hammer",
  description:
    "Balanced agent that reads and writes files with automatic approval for safe operations. Asks before destructive actions. Recommended for daily development work.",
  permission: mergeRulesets(
    DEFAULT_PERMISSIONS,
    fromConfig({
      read: "allow",
      edit: "ask",
      question: "allow",
      bash: {
        "git status": "allow",
        "git diff": "allow",
        "git log": "allow",
        "git branch": "allow",
        "git checkout": "allow",
        "git add": "allow",
        "git commit": "allow",
        "git pull": "allow",
        "git push": "allow",
        "git stash": "allow",
        "git reset": "allow",
        "npm run": "allow",
        "pnpm run": "allow",
        "yarn run": "allow",
        "bun run": "allow",
        "npm install": "allow",
        "pnpm install": "allow",
        "yarn install": "allow",
        "bun install": "allow",
        ls: "allow",
        cat: "allow",
        pwd: "allow",
        which: "allow",
        date: "allow",
        echo: "allow",
        python: "ask",
        node: "ask",
        cargo: "ask",
        go: "ask",
        make: "ask",
        "*": "ask",
      },
    }),
  ),
};

const PLAN_AGENT: AgentInfo = {
  name: "plan",
  category: "general",
  mode: "primary",
  native: true,
  color: "#64b5f6",
  icon: "clipboard-list",
  description:
    "Read-only planning agent. Explores the codebase, creates task plans, and proposes changes without writing files. Use when you want to explore before making changes.",
  permission: mergeRulesets(
    DEFAULT_PERMISSIONS,
    fromConfig({
      edit: "deny",
      write: "deny",
      bash: {
        "git status": "allow",
        "git diff": "allow",
        "git log": "allow",
        "git branch": "allow",
        ls: "allow",
        cat: "allow",
        pwd: "allow",
        which: "allow",
        find: "allow",
        grep: "allow",
        head: "allow",
        tail: "allow",
        wc: "allow",
        "*": "deny",
      },
      question: "allow",
      read: {
        task: "deny",
        "*": "allow",
      },
      webfetch: "allow",
      websearch: "allow",
    }),
  ),
};

const GENERAL_SUBAGENT: AgentInfo = {
  name: "general",
  category: "general",
  mode: "subagent",
  native: true,
  color: "#aac4e1",
  icon: "cpu",
  description:
    "General-purpose subagent for researching complex questions, executing multi-step tasks, and running parallel work units.",
  permission: mergeRulesets(
    DEFAULT_PERMISSIONS,
    fromConfig({ change_directory: "deny" }),
  ),
};

const EXPLORE_SUBAGENT: AgentInfo = {
  name: "explore",
  category: "explore",
  mode: "subagent",
  native: true,
  color: "#f5c9b0",
  icon: "search",
  description:
    "Fast subagent specialized for exploring codebases. Use for quickly understanding file structures, finding references, or summarizing modules.",
  permission: mergeRulesets(
    DEFAULT_PERMISSIONS,
    fromConfig({
      edit: "deny",
      write: "deny",
      bash: "deny",
    }),
  ),
};

const TITLE_SUBAGENT: AgentInfo = {
  name: "title",
  category: "title",
  mode: "subagent",
  native: true,
  color: "#dcd7a8",
  icon: "heading",
  description:
    "Generates a short, descriptive title for the conversation based on context.",
  permission: fromConfig({ "*": "deny", skill: "allow" }),
};

const SUMMARY_SUBAGENT: AgentInfo = {
  name: "summary",
  category: "summary",
  mode: "subagent",
  native: true,
  color: "#9ec1cf",
  icon: "file-text",
  description:
    "Summarizes long conversation histories into a compact form for context window management.",
  permission: fromConfig({ "*": "deny" }),
};

const COMPACTION_SUBAGENT: AgentInfo = {
  name: "compaction",
  category: "compaction",
  mode: "subagent",
  native: true,
  color: "#c4a7e7",
  icon: "compress",
  description:
    "Compresses context to keep the conversation within model context windows by summarizing older messages.",
  permission: fromConfig({ "*": "deny" }),
};

const DREAM_SUBAGENT: AgentInfo = {
  name: "dream",
  category: "dream",
  mode: "subagent",
  native: true,
  color: "#f6c4a8",
  icon: "moon",
  description:
    "Generates creative, exploratory code or design proposals for ambiguous tasks. Useful for brainstorming.",
  permission: fromConfig({ "*": "deny" }),
};

const DISTILL_SUBAGENT: AgentInfo = {
  name: "distill",
  category: "distill",
  mode: "subagent",
  native: true,
  color: "#a8c4f6",
  icon: "droplets",
  description:
    "Extracts the essential structure from a body of code or text, producing concise summaries.",
  permission: fromConfig({ "*": "deny" }),
};

export const ALL_AGENTS: AgentInfo[] = [
  YOLO_AGENT,
  BUILD_AGENT,
  PLAN_AGENT,
  GENERAL_SUBAGENT,
  EXPLORE_SUBAGENT,
  TITLE_SUBAGENT,
  SUMMARY_SUBAGENT,
  COMPACTION_SUBAGENT,
  DREAM_SUBAGENT,
  DISTILL_SUBAGENT,
];

export const PRIMARY_AGENTS: AgentInfo[] = ALL_AGENTS.filter(
  (a) => a.mode === "primary",
);
export const SUBAGENTS: AgentInfo[] = ALL_AGENTS.filter(
  (a) => a.mode === "subagent",
);

export function getAgent(name: string): AgentInfo | undefined {
  return ALL_AGENTS.find((a) => a.name === name);
}

export function getPrimaryAgent(name: PrimaryAgentName): AgentInfo {
  const a = getAgent(name);
  if (!a) throw new Error(`Unknown primary agent: ${name}`);
  return a;
}
