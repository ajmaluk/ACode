import { describe, it, expect } from "vitest";
import {
  fromConfig,
  mergeRulesets,
  evaluate,
  canonicaliseBashCommand,
  getAgent,
  getPrimaryAgent,
  SUBAGENTS,
  ALL_AGENTS,
  PRIMARY_AGENTS,
} from "./agents";

describe("agents", () => {
  describe("fromConfig", () => {
    it("converts shorthand config to ruleset", () => {
      const rules = fromConfig({ bash: "allow", edit: "deny" });
      expect(rules).toHaveLength(2);
      expect(rules[0]).toEqual({ permission: "bash", pattern: "*", action: "allow" });
    });

    it("converts per-pattern config to ruleset", () => {
      const rules = fromConfig({
        bash: { "git status": "allow", "rm *": "deny" },
      });
      expect(rules).toHaveLength(2);
      expect(rules[0]).toEqual({ permission: "bash", pattern: "git status", action: "allow" });
    });

    it("handles empty config", () => {
      const rules = fromConfig({});
      expect(rules).toHaveLength(0);
    });

    it("handles mixed shorthand and per-pattern", () => {
      const rules = fromConfig({
        bash: "allow",
        edit: { "*.ts": "ask", "*.md": "deny" },
      });
      expect(rules).toHaveLength(3);
    });
  });

  describe("mergeRulesets", () => {
    it("later rules override earlier ones for same permission+pattern", () => {
      const a = fromConfig({ bash: "ask" });
      const b = fromConfig({ bash: "allow" });
      const merged = mergeRulesets(a, b);
      expect(merged).toHaveLength(1);
      expect(merged[0].action).toBe("allow");
    });

    it("preserves distinct rules", () => {
      const a = fromConfig({ bash: "allow" });
      const b = fromConfig({ edit: "deny" });
      const merged = mergeRulesets(a, b);
      expect(merged).toHaveLength(2);
    });

    it("handles empty rulesets", () => {
      const merged = mergeRulesets([], []);
      expect(merged).toHaveLength(0);
    });

    it("handles single ruleset", () => {
      const rules = fromConfig({ bash: "allow" });
      const merged = mergeRulesets(rules);
      expect(merged).toHaveLength(1);
    });

    it("multiple overrides keep last", () => {
      const a = fromConfig({ bash: "deny" });
      const b = fromConfig({ bash: "ask" });
      const c = fromConfig({ bash: "allow" });
      const merged = mergeRulesets(a, b, c);
      expect(merged).toHaveLength(1);
      expect(merged[0].action).toBe("allow");
    });
  });

  describe("evaluate", () => {
    it("returns action for matching rule", () => {
      const rules = fromConfig({ bash: "allow" });
      expect(evaluate(rules, "bash", "*")).toBe("allow");
    });

    it("falls back to permission wildcard", () => {
      const rules = [{ permission: "bash", pattern: "rm *", action: "deny" as const }];
      expect(evaluate(rules, "bash", "git status")).toBe("ask");
    });

    it("falls back to global wildcard", () => {
      const rules = [{ permission: "*", pattern: "*", action: "allow" as const }];
      expect(evaluate(rules, "anything", "pattern")).toBe("allow");
    });

    it("defaults to ask when no rules match", () => {
      expect(evaluate([], "bash", "rm *")).toBe("ask");
    });

    it("exact pattern match wins over wildcard when listed first", () => {
      const rules = [
        { permission: "bash", pattern: "git status", action: "allow" as const },
        { permission: "bash", pattern: "*", action: "ask" as const },
      ];
      expect(evaluate(rules, "bash", "git status")).toBe("allow");
    });

    it("wildcard wins when listed first (rules are evaluated in order)", () => {
      const rules = [
        { permission: "bash", pattern: "*", action: "ask" as const },
        { permission: "bash", pattern: "git status", action: "allow" as const },
      ];
      expect(evaluate(rules, "bash", "git status")).toBe("ask");
    });

    it("glob patterns work", () => {
      const rules = [{ permission: "edit", pattern: "*.ts", action: "allow" as const }];
      expect(evaluate(rules, "edit", "index.ts")).toBe("allow");
      expect(evaluate(rules, "edit", "src/index.ts")).toBe("ask");
      expect(evaluate(rules, "edit", "index.js")).toBe("ask");
    });

    it("handles special regex characters in pattern", () => {
      const rules = [{ permission: "bash", pattern: "npm run dev", action: "allow" as const }];
      expect(evaluate(rules, "bash", "npm run dev")).toBe("allow");
      expect(evaluate(rules, "bash", "npm run build")).toBe("ask");
    });

    it("permission takes precedence over pattern", () => {
      const rules = [
        { permission: "*", pattern: "*", action: "deny" as const },
        { permission: "bash", pattern: "*", action: "allow" as const },
      ];
      expect(evaluate(rules, "bash", "ls")).toBe("allow");
    });
  });

  describe("canonicaliseBashCommand", () => {
    it("returns single-token commands", () => {
      expect(canonicaliseBashCommand("ls")).toBe("ls");
    });

    it("returns multi-token commands", () => {
      expect(canonicaliseBashCommand("git checkout main")).toBe("git checkout");
    });

    it("handles extra arguments", () => {
      expect(canonicaliseBashCommand("npm install react --save")).toBe("npm install");
    });

    it("returns first token for unknown commands", () => {
      expect(canonicaliseBashCommand("unknowncmd foo bar")).toBe("unknowncmd");
    });

    it("handles empty string", () => {
      expect(canonicaliseBashCommand("")).toBe("");
    });

    it("handles whitespace-only", () => {
      expect(canonicaliseBashCommand("   ")).toBe("");
    });

    it("handles 3-token commands", () => {
      expect(canonicaliseBashCommand("git stash pop")).toBe("git stash pop");
    });

    it("normalizes extra spaces", () => {
      expect(canonicaliseBashCommand("  git   checkout  main  ")).toBe("git checkout");
    });
  });

  describe("agent definitions", () => {
    it("has 10 total agents (3 primary + 7 subagents)", () => {
      expect(ALL_AGENTS).toHaveLength(10);
    });

    it("has 7 subagents", () => {
      expect(SUBAGENTS).toHaveLength(7);
    });

    it("has 3 primary agents", () => {
      expect(PRIMARY_AGENTS).toHaveLength(3);
    });

    it("getAgent returns correct agent", () => {
      const agent = getAgent("yolo");
      expect(agent).toBeDefined();
      expect(agent!.name).toBe("yolo");
      expect(agent!.mode).toBe("primary");
    });

    it("getAgent returns undefined for unknown", () => {
      expect(getAgent("nonexistent")).toBeUndefined();
    });

    it("getPrimaryAgent throws for unknown name", () => {
      expect(() => // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getPrimaryAgent("unknown" as any)).toThrow("Unknown primary agent");
    });

    it("yolo agent allows everything", () => {
      const agent = getPrimaryAgent("yolo");
      const action = evaluate(agent.permission, "bash", "rm -rf /");
      expect(action).toBe("allow");
    });

    it("yolo agent allows question", () => {
      const agent = getPrimaryAgent("yolo");
      const action = evaluate(agent.permission, "question", "*");
      expect(action).toBe("allow");
    });

    it("explore agent denies edit", () => {
      const agent = getAgent("explore");
      expect(agent).toBeDefined();
      const action = evaluate(agent!.permission, "edit", "file.ts");
      expect(action).toBe("deny");
    });

    it("all agents have permission arrays", () => {
      for (const agent of ALL_AGENTS) {
        expect(Array.isArray(agent.permission)).toBe(true);
        expect(agent.permission.length).toBeGreaterThan(0);
      }
    });

    it("all agents have required fields", () => {
      for (const agent of ALL_AGENTS) {
        expect(agent.name).toBeTruthy();
        expect(agent.category).toBeTruthy();
        expect(agent.mode).toBeTruthy();
      }
    });
  });
});
