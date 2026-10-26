// Extension -> LSP languageId, scoped to the servers we know how to run.
// (opencode's equivalent table covers ~60 languages; we start with the three
// we actually spawn servers for and can grow this alongside `server.ts`.)
export const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
}

export function languageIdFor(ext: string): string | undefined {
  return LANGUAGE_IDS[ext]
}
