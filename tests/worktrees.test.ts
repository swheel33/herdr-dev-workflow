import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { localBranchExists, worktreeForBranch } from "../src/git.js"
import type { HerdrClient } from "../src/herdr.js"
import { StateStore } from "../src/state.js"
import { prepareTarget } from "../src/worktrees.js"
import { gitFixture } from "./helpers.js"

describe("target preparation failures", () => {
  it("preserves a new target when workspace creation fails", () => {
    const fixture = gitFixture()
    const store = new StateStore(resolve(mkdtempSync(resolve(tmpdir(), "wheels-target-")), "workflow.sqlite"))
    const herdr = {
      openWorktree: () => { throw new Error("Herdr unavailable") },
    } as unknown as HerdrClient
    try {
      expect(() => prepareTarget({
        repoRoot: fixture.root,
        target: { kind: "new", value: "failure" },
        store,
        herdr,
      })).toThrow("Herdr unavailable")
      expect(worktreeForBranch(fixture.root, "wheels/failure")).not.toBeNull()
      expect(localBranchExists(fixture.root, "wheels/failure")).toBe(true)
      expect(store.managedTarget(fixture.root, "wheels/failure")).not.toBeNull()
    } finally {
      store.close()
      fixture.dispose()
    }
  })
})
