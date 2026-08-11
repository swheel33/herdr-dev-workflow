import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { scanMerged } from "../src/auto-prune.js"
import { createWorktree, git } from "../src/git.js"
import type { HerdrClient } from "../src/herdr.js"
import { StateStore } from "../src/state.js"
import { gitFixture } from "./helpers.js"

describe("automatic pruning", () => {
  it("ignores a managed checkout that changed branches", () => {
    const fixture = gitFixture()
    const store = new StateStore(resolve(mkdtempSync(resolve(tmpdir(), "wheels-prune-")), "workflow.sqlite"))
    try {
      store.rememberRepository(fixture.root)
      const checkout = resolve(fixture.root, ".worktrees/task")
      createWorktree(fixture.root, checkout, "wheels/task", "main")
      store.registerManagedTarget({
        repoRoot: fixture.root,
        branch: "wheels/task",
        checkoutPath: checkout,
        createdOid: git(fixture.root, "rev-parse", "wheels/task"),
        ownsLocal: true,
      })
      git(fixture.root, "branch", "feature/other", "main")
      git(checkout, "checkout", "feature/other")
      let closed = false
      const herdr = {
        workspaces: () => [],
        runningSessionCount: () => 1,
        closeWorkspace: () => { closed = true },
      } as unknown as HerdrClient

      expect(scanMerged(store, herdr)).toEqual({ checked: 0, closed: 0, blocked: 0 })
      expect(closed).toBe(false)
    } finally {
      store.close()
      fixture.dispose()
    }
  })

  it("closes any clean idle dispatched worktree after its exact head is merged", () => {
    const fixture = gitFixture()
    const store = new StateStore(resolve(mkdtempSync(resolve(tmpdir(), "wheels-prune-")), "workflow.sqlite"))
    try {
      store.rememberRepository(fixture.root)
      const checkout = resolve(fixture.root, ".worktrees/merged")
      createWorktree(fixture.root, checkout, "feature/merged", "main")
      store.registerManagedTarget({
        repoRoot: fixture.root,
        branch: "feature/merged",
        checkoutPath: checkout,
        createdOid: git(fixture.root, "rev-parse", "feature/merged"),
        ownsLocal: false,
      })
      git(checkout, "commit", "--allow-empty", "-m", "implementation")
      git(fixture.root, "merge", "--no-ff", "feature/merged", "-m", "merge implementation")
      git(fixture.root, "push", "origin", "main")
      let closedWorkspace = ""
      const herdr = {
        workspaces: () => [{
          workspace_id: "w-test",
          focused: false,
          agent_status: "idle",
          worktree: { checkout_path: checkout },
        }],
        runningSessionCount: () => 1,
        closeWorkspace: (workspaceId: string) => { closedWorkspace = workspaceId },
        notify: () => undefined,
      } as unknown as HerdrClient

      expect(scanMerged(store, herdr)).toEqual({ checked: 1, closed: 1, blocked: 0 })
      expect(closedWorkspace).toBe("w-test")
      expect(store.recentLogs(10).some((entry) => entry.kind === "auto-prune.closed")).toBe(true)
    } finally {
      store.close()
      fixture.dispose()
    }
  })
})
