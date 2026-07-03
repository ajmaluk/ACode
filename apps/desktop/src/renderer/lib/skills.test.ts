import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  skillInfoFromParsed,
  BUNDLED_SKILLS,
  skillRegistry,
  matchSkillInvocation,
  renderSkillForPrompt,
} from "./skills";

describe("skills", () => {
  describe("parseFrontmatter", () => {
    it("parses YAML frontmatter", () => {
      const input = "---\nname: my-skill\ndescription: A test\n---\n\nBody content";
      const { frontmatter, body } = parseFrontmatter(input);
      expect(frontmatter.name).toBe("my-skill");
      expect(frontmatter.description).toBe("A test");
      expect(body).toBe("Body content");
    });

    it("returns raw content when no frontmatter", () => {
      const { frontmatter, body } = parseFrontmatter("No frontmatter here");
      expect(Object.keys(frontmatter)).toHaveLength(0);
      expect(body).toBe("No frontmatter here");
    });

    it("handles quoted values", () => {
      const input = '---\nname: "quoted-name"\n---\n\nBody';
      const { frontmatter } = parseFrontmatter(input);
      expect(frontmatter.name).toBe("quoted-name");
    });

    it("skips comments and empty lines", () => {
      const input = "---\n# comment\nname: test\n\n---\n\nBody";
      const { frontmatter } = parseFrontmatter(input);
      expect(frontmatter.name).toBe("test");
    });
  });

  describe("skillInfoFromParsed", () => {
    it("creates SkillInfo from valid frontmatter", () => {
      const info = skillInfoFromParsed({ name: "test" }, "body", "/path", "bundled");
      expect(info).not.toBeNull();
      expect(info!.name).toBe("test");
      expect(info!.content).toBe("body");
    });

    it("returns null when name is missing", () => {
      const info = skillInfoFromParsed({}, "body", "/path", "bundled");
      expect(info).toBeNull();
    });

    it("defaults description to name", () => {
      const info = skillInfoFromParsed({ name: "test" }, "body", "/path", "bundled");
      expect(info!.description).toBe("test");
    });
  });

  describe("BUNDLED_SKILLS", () => {
    it("has 9 bundled skills", () => {
      expect(BUNDLED_SKILLS).toHaveLength(9);
    });

    it("each has required fields", () => {
      for (const skill of BUNDLED_SKILLS) {
        expect(skill.name).toBeTruthy();
        expect(skill.description).toBeTruthy();
        expect(skill.content).toBeTruthy();
        expect(skill.source).toBe("bundled");
      }
    });
  });

  describe("skillRegistry", () => {
    it("lists all bundled skills", () => {
      const list = skillRegistry.list();
      expect(list.length).toBeGreaterThanOrEqual(9);
    });

    it("gets skill by name", () => {
      const skill = skillRegistry.get("explain");
      expect(skill).toBeDefined();
      expect(skill!.name).toBe("explain");
    });
  });

  describe("matchSkillInvocation", () => {
    it("matches $skill-name pattern", () => {
      const skills = BUNDLED_SKILLS;
      const result = matchSkillInvocation("$explain what is this code", skills);
      expect(result).not.toBeNull();
      expect(result!.skill.name).toBe("explain");
      expect(result!.args).toBe("what is this code");
    });

    it("returns null for no match", () => {
      const result = matchSkillInvocation("no skill here", BUNDLED_SKILLS);
      expect(result).toBeNull();
    });

    it("returns null for unknown skill", () => {
      const result = matchSkillInvocation("$nonexistent args", BUNDLED_SKILLS);
      expect(result).toBeNull();
    });
  });

  describe("renderSkillForPrompt", () => {
    it("renders skill name and content", () => {
      const skill = BUNDLED_SKILLS[0];
      const rendered = renderSkillForPrompt(skill);
      expect(rendered).toContain(skill.name);
      expect(rendered).toContain(skill.description);
      expect(rendered).toContain(skill.content);
    });

    it("renders with proper formatting markers", () => {
      const skill = BUNDLED_SKILLS[0];
      const rendered = renderSkillForPrompt(skill);
      expect(rendered).toContain("Skill:");
      expect(rendered.startsWith("\n")).toBe(true);
    });
  });

  describe("parseFrontmatter edge cases", () => {
    it("handles empty string", () => {
      const { frontmatter, body } = parseFrontmatter("");
      expect(Object.keys(frontmatter)).toHaveLength(0);
      expect(body).toBe("");
    });

    it("handles only frontmatter with no body", () => {
      const input = "---\nname: test\ndescription: desc\n---\n";
      const { frontmatter, body } = parseFrontmatter(input);
      expect(frontmatter.name).toBe("test");
      expect(body).toBe("");
    });

    it("handles frontmatter with unicode values", () => {
      const input = '---\nname: スキル\ndescription: テスト\n---\n\nBody';
      const { frontmatter } = parseFrontmatter(input);
      expect(frontmatter.name).toBe("スキル");
      expect(frontmatter.description).toBe("テスト");
    });

    it("handles frontmatter with only the name field", () => {
      const input = "---\nname: minimal\n---\n\nContent";
      const { frontmatter, body } = parseFrontmatter(input);
      expect(frontmatter.name).toBe("minimal");
      expect(body).toBe("Content");
    });

    it("handles values with trailing spaces", () => {
      const input = "---\nname:  my-skill  \ndescription:  a test  \n---\n\nBody";
      const { frontmatter } = parseFrontmatter(input);
      // Parser trims the value after stripping quotes
      expect(frontmatter.name).toBe("my-skill");
      expect(frontmatter.description).toBe("a test");
    });

    it("handles comments in frontmatter", () => {
      const input = [
        "---",
        "# this is a comment",
        "name: my-skill",
        "# another comment",
        "description: desc",
        "---",
        "",
        "Body"
      ].join("\n");
      const { frontmatter } = parseFrontmatter(input);
      expect(frontmatter.name).toBe("my-skill");
      expect(frontmatter.description).toBe("desc");
    });

    it("handles empty lines in frontmatter", () => {
      const input = [
        "---",
        "name: my-skill",
        "",
        "description: desc",
        "---",
        "",
        "Body"
      ].join("\n");
      const { frontmatter } = parseFrontmatter(input);
      expect(frontmatter.name).toBe("my-skill");
      expect(frontmatter.description).toBe("desc");
    });

    it("handles key with hyphens in name", () => {
      const input = "---\nname: my-skill\n---\n\nBody";
      const { frontmatter } = parseFrontmatter(input);
      expect(frontmatter.name).toBe("my-skill");
    });
  });

  describe("skillInfoFromParsed edge cases", () => {
    it("returns null when name is empty", () => {
      const info = skillInfoFromParsed({ name: "" }, "body", "/path", "bundled");
      expect(info).toBeNull();
    });

    it("returns null when name is whitespace-only", () => {
      const info = skillInfoFromParsed({ name: "   " }, "body", "/path", "bundled");
      expect(info).toBeNull();
    });

    it("uses name as description when description missing", () => {
      const info = skillInfoFromParsed({ name: "test" }, "body", "/path", "project");
      expect(info!.description).toBe("test");
      expect(info!.source).toBe("project");
    });
  });

  describe("matchSkillInvocation edge cases", () => {
    it("prefers explicit $skill-name over word match", () => {
      const skills = [
        { name: "plan", description: "Plan skill", content: "body", location: "", source: "bundled" as const },
        { name: "explain", description: "Explain skill", content: "body", location: "", source: "bundled" as const },
      ];
      // The fallback word-match should NOT trigger for long prompts
      const result = matchSkillInvocation("I need you to explain this code to me in detail", skills);
      expect(result).toBeNull();
    });

    it("matches $skill-name at start of text", () => {
      const skills = [
        { name: "refactor", description: "Refactor", content: "body", location: "", source: "bundled" as const },
      ];
      const result = matchSkillInvocation("$refactor this component", skills);
      expect(result).not.toBeNull();
      expect(result!.skill.name).toBe("refactor");
      expect(result!.args).toBe("this component");
    });

    it("matches $skill-name in middle of text", () => {
      const skills = [
        { name: "debug", description: "Debug", content: "body", location: "", source: "bundled" as const },
      ];
      const result = matchSkillInvocation("please $debug this function", skills);
      expect(result).not.toBeNull();
      expect(result!.skill.name).toBe("debug");
    });

    it("returns args as empty string when $skill has no args", () => {
      const skills = [
        { name: "plan", description: "Plan", content: "body", location: "", source: "bundled" as const },
      ];
      const result = matchSkillInvocation("$plan", skills);
      expect(result).not.toBeNull();
      expect(result!.args).toBe("");
    });

    it("matches skill names with hyphens", () => {
      const skills = [
        { name: "code-review", description: "Review", content: "body", location: "", source: "bundled" as const },
      ];
      const result = matchSkillInvocation("$code-review this PR", skills);
      expect(result).not.toBeNull();
      expect(result!.skill.name).toBe("code-review");
    });
  });

  describe("skillRegistry edge cases", () => {
    it("add skill creates backup when overwriting", () => {
      skillRegistry.add({ name: "overwrite-test", description: "v1", content: "old content", location: "test", source: "bundled" });
      skillRegistry.add({ name: "overwrite-test", description: "v2", content: "new content", location: "test", source: "project" });
      const backups = skillRegistry.getBackups("overwrite-test");
      expect(backups.length).toBeGreaterThanOrEqual(1);
      expect(backups[0].skill.description).toBe("v1");
      // Clean up
      skillRegistry.remove("overwrite-test");
    });

    it("restoreFromBackup restores the correct version", () => {
      skillRegistry.add({ name: "restore-test", description: "v1", content: "old", location: "", source: "bundled" });
      skillRegistry.add({ name: "restore-test", description: "v2", content: "new", location: "", source: "project" });
      const backups = skillRegistry.getBackups("restore-test");
      const restored = skillRegistry.restoreFromBackup("restore-test", backups[0].timestamp);
      expect(restored).toBeDefined();
      expect(restored!.description).toBe("v1");
      skillRegistry.remove("restore-test");
    });

    it("restoreFromBackup returns undefined for nonexistent backup", () => {
      const result = skillRegistry.restoreFromBackup("nonexistent", 12345);
      expect(result).toBeUndefined();
    });

    it("getBackups returns empty for skill without backups", () => {
      expect(skillRegistry.getBackups("explain")).toEqual([]);
    });

    it("enabled filters by set membership", () => {
      const enabled = new Set(["explain", "plan"]);
      const result = skillRegistry.enabled(enabled);
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.every(s => enabled.has(s.name))).toBe(true);
    });
  });

  describe("loadSkillContent", () => {
    it("returns content immediately when already loaded", async () => {
      const skill: SkillInfo = { name: "test", description: "test", content: "existing", location: "", source: "bundled" };
      const content = await loadSkillContent(skill);
      expect(content).toBe("existing");
    });

    it("returns empty string for bundled skill without content", async () => {
      const skill: SkillInfo = { name: "test", description: "test", content: "", location: "bundled://test/SKILL.md", source: "bundled" };
      const content = await loadSkillContent(skill);
      expect(content).toBe("");
    });

    it("returns empty string when no fsAdapter provided", async () => {
      const skill: SkillInfo = { name: "test", description: "test", content: "", location: "/custom/path/SKILL.md", source: "project" };
      const content = await loadSkillContent(skill);
      expect(content).toBe("");
    });
  });
});
