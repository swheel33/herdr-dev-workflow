import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { StateStore } from "../src/state.js"

const stores: StateStore[] = []

function store(): StateStore {
  const state = new StateStore(resolve(mkdtempSync(resolve(tmpdir(), "wheels-state-")), "workflow.sqlite"))
  stores.push(state)
  return state
}

afterEach(() => {
  while (stores.length) stores.pop()!.close()
})

describe("dispatch receipts", () => {
  it("accepts one dispatch per source message", () => {
    const state = store()
    const input = {
      sourceSessionId: "session-1",
      sourceMessageId: "message-1",
      projectRoot: "/tmp/repo",
      request: "",
      targetKind: "new" as const,
      targetValue: "task",
    }
    expect(state.beginDispatch(input)).toBe(true)
    expect(state.beginDispatch(input)).toBe(false)
  })
})

describe("managed ownership", () => {
  it("requires explicit repository and branch ownership", () => {
    const state = store()
    state.registerManagedTarget({
      repoRoot: "/tmp/repo-a",
      branch: "wheels/task",
      checkoutPath: "/tmp/repo-a/.worktrees/task",
      createdOid: "abc",
      remote: "origin",
      remoteBranch: "wheels/task",
      ownsLocal: true,
      ownsRemote: true,
    })
    expect(state.managedTarget("/tmp/repo-a", "wheels/task")).not.toBeNull()
    expect(state.managedTarget("/tmp/repo-b", "wheels/task")).toBeNull()
    expect(state.managedTarget("/tmp/repo-a", "feature/task")).toBeNull()
    state.registerManagedTarget({
      repoRoot: "/tmp/repo-a",
      branch: "wheels/task",
      checkoutPath: "/tmp/repo-a/.worktrees/task-2",
      createdOid: "def",
      ownsLocal: false,
    })
    const updated = state.managedTarget("/tmp/repo-a", "wheels/task")
    expect(updated?.checkout_path).toBe("/tmp/repo-a/.worktrees/task-2")
    expect(updated?.owns_local).toBe(1)
    expect(updated?.owns_remote).toBe(1)
  })
})

describe("durable safety state", () => {
  it("does not expire completed event identities", () => {
    const state = store()
    state.markEventComplete("workspace-1")
    expect(state.eventCompleted("workspace-1")).toBe(true)
  })

  it("retains only the newest diagnostic messages", () => {
    const state = store()
    for (let index = 0; index < 1005; index += 1) state.log("info", "test", String(index))
    expect(state.recentLogs(2000)).toHaveLength(1000)
    expect(state.recentLogs(1)[0]?.message).toBe("1004")
  })
})
