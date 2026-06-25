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
  });
});
