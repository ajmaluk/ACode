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
