import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("agent-driven manifest", () => {
  it("does not expose manual worktree actions", () => {
    const manifest = readFileSync(resolve("herdr-plugin.toml"), "utf8")
    expect(manifest).not.toContain('id = "new-branch"')
    expect(manifest).not.toContain('id = "open"')
    expect(manifest).not.toContain('id = "open-all"')
    expect(manifest).not.toContain('id = "adopt-workspaces"')
    expect(manifest).not.toContain('id = "chat-picker"')
    expect(manifest).not.toContain('id = "retry-cleanup"')
    expect(manifest).not.toContain('id = "show-cleanup-failures"')
    expect(manifest).not.toContain('id = "doctor"')
    expect(manifest).toContain('id = "chat-current"')
    expect(manifest).toContain('title = "Project Chat"')
    expect(manifest).toContain('id = "chat-history"')
    expect(manifest).toContain('title = "History"')
    expect(manifest).toContain('id = "workflow-status"')
  })
})
