import { z } from "zod"
import { defineTool } from "./types"

const TodoItem = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
})

const Parameters = z.object({
  todos: z.array(TodoItem).describe("The full updated todo list (replaces the previous one)"),
})

const store = new Map<string, z.infer<typeof TodoItem>[]>()

export function getTodos(sessionID: string) {
  return store.get(sessionID) ?? []
}

export const TodoWriteTool = defineTool({
  id: "todo",
  description: "Writes/updates the task todo list for this session. Use it to plan and track progress on multi-step work.",
  parameters: Parameters,
  async execute(params, ctx) {
    store.set(ctx.sessionID, params.todos)
    const rendered = params.todos
      .map((t) => `[${t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : " "}] ${t.content}`)
      .join("\n")
    return {
      title: `${params.todos.length} todo(s)`,
      output: rendered || "(empty todo list)",
      metadata: { count: params.todos.length },
    }
  },
})
