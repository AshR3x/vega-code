import { z } from "zod"
import { defineTool } from "./types"
import { getSkill, listSkills, renderSkill } from "@/skill"

const Parameters = z.object({
  id: z.string().describe("The id of an available skill or a skill explicitly referenced by the user"),
})

export const SkillTool = defineTool({
  id: "skill",
  description:
    "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description. The id must match an available skill or a skill explicitly referenced by the user.",
  parameters: Parameters,
  async execute(params, ctx) {
    const skill = await getSkill(params.id, ctx.cwd)
    if (!skill) {
      const available = (await listSkills(ctx.cwd)).map((s) => s.id)
      throw new Error(
        available.length > 0
          ? `Unknown skill: ${params.id}. Available: ${available.join(", ")}`
          : `Unknown skill: ${params.id}. No skills found under .vega/skills or ~/.vega-code/skills.`,
      )
    }
    return {
      title: skill.name,
      output: await renderSkill(skill),
      metadata: { name: skill.name },
    }
  },
})
