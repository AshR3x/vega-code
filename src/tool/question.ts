import { z } from "zod"
import { defineTool } from "./types"

const Option = z.object({
  label: z.string().describe("Short label shown in the option list (1-5 words)"),
  description: z.string().describe("Explanation of what this option means or implies"),
})

const Prompt = z.object({
  header: z.string().describe("Very short label for the question (max ~12 chars)"),
  question: z.string().describe("The complete question to ask the user"),
  options: z.array(Option).describe("The choices to offer"),
  multiple: z.boolean().optional().describe("Allow selecting more than one option"),
})

const Parameters = z.object({
  questions: z.array(Prompt).min(1).describe("Questions to ask the user"),
})

const DESCRIPTION = [
  "Use this tool when you need to ask the user questions during execution. This allows you to:",
  "1. Gather user preferences or requirements",
  "2. Clarify ambiguous instructions",
  "3. Get decisions on implementation choices as you work",
  "4. Offer choices to the user about what direction to take.",
  "",
  "Usage notes:",
  "- A free-form answer is always accepted; the user can type their own instead of picking an option",
  "- Set `multiple: true` to allow selecting more than one option",
  "- If you recommend a specific option, make that the first option in the list and add \"(Recommended)\" at the end of the label",
].join("\n")

export const QuestionTool = defineTool({
  id: "question",
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params, ctx) {
    const answers: string[] = []
    for (const prompt of params.questions) {
      const lines = [prompt.question, ""]
      prompt.options.forEach((option, index) => lines.push(`  ${index + 1}) ${option.label}${option.description ? ` — ${option.description}` : ""}`))
      lines.push("")
      lines.push(prompt.multiple ? "Select one or more numbers (comma-separated), or type your own answer:" : "Select a number, or type your own answer:")

      const reply = (await ctx.askText(lines.join("\n"))).trim()
      if (reply === "") {
        answers.push("Unanswered")
        continue
      }
      const picks = reply
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= prompt.options.length)
      if (picks.length > 0) {
        const chosen = prompt.multiple ? picks.map((n) => prompt.options[n - 1]!.label) : [prompt.options[picks[0]! - 1]!.label]
        answers.push(chosen.join(", "))
      } else {
        answers.push(reply)
      }
    }

    const formatted = params.questions
      .map((question, index) => `"${question.question}"="${answers[index] || "Unanswered"}"`)
      .join(", ")

    return {
      title: `${params.questions.length} question(s)`,
      output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
      metadata: { answers },
    }
  },
})
