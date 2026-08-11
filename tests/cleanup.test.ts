import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { attemptCleanup, enqueueCleanup } from "../src/cleanup.js"
import { createTrackingWorktree, createWorktree, git, localBranchExists, remoteBranchExists, worktreeForPath } from "../src/git.js"
import { StateStore } from "../src/state.js"
import { gitFixture, type GitFixture } from "./helpers.js"

const fixtures: GitFixture[] = []
const stores: StateStore[] = []

afterEach(() => {
  while (stores.length) stores.pop()!.close()
  while (fixtures.length) fixtures.pop()!.dispose()
})

function state(): StateStore {
  const value = new StateStore(resolve(mkdtempSync(resolve(tmpdir(), "wheels-cleanup-")), "workflow.sqlite"))
  stores.push(value)
  return value
}

describe("cleanup ownership", () => {
  it("deletes a remotely published plugin-owned wheels branch", () => {
    const fixture = gitFixture(); fixtures.push(fixture)
    const store = state()
    const checkout = resolve(fixture.root, ".worktrees/task")
    createWorktree(fixture.root, checkout, "wheels/task", "main")
    git(checkout, "push", "-u", "origin", "wheels/task")
    store.registerManagedTarget({
      repoRoot: fixture.root,
      branch: "wheels/task",
      checkoutPath: checkout,
      createdOid: git(fixture.root, "rev-parse", "wheels/task"),
      remote: "origin",
      remoteUrl: fixture.origin,
      remoteBranch: "wheels/task",
      ownsLocal: true,
      ownsRemote: true,
    })
    const job = enqueueCleanup({ store, repoRoot: fixture.root, checkoutPath: checkout, branch: "wheels/task", source: "test" })
    expect(job.deleteRemote).toBe(true)
    expect(attemptCleanup(store, job)).toBe(true)
    expect(localBranchExists(fixture.root, "wheels/task")).toBe(false)
    expect(remoteBranchExists(fixture.root, "wheels/task")).toBe(false)
  })

  it("preserves an existing feature branch on the remote", () => {
    const fixture = gitFixture(); fixtures.push(fixture)
    const store = state()
    git(fixture.root, "branch", "feature/existing", "main")
    git(fixture.root, "push", "-u", "origin", "feature/existing")
    const checkout = resolve(fixture.root, ".worktrees/feature")
    createTrackingWorktree(fixture.root, checkout, "feature/existing")
    store.registerManagedTarget({
      repoRoot: fixture.root,
      branch: "feature/existing",
      checkoutPath: checkout,
      createdOid: git(fixture.root, "rev-parse", "feature/existing"),
      remote: "origin",
      remoteUrl: fixture.origin,
      remoteBranch: "feature/existing",
      ownsLocal: false,
    })
    const job = enqueueCleanup({ store, repoRoot: fixture.root, checkoutPath: checkout, branch: "feature/existing", source: "test" })
    expect(job.deleteLocal).toBe(false)
    expect(job.deleteRemote).toBe(false)
    expect(attemptCleanup(store, job)).toBe(true)
    expect(localBranchExists(fixture.root, "feature/existing")).toBe(true)
    expect(remoteBranchExists(fixture.root, "feature/existing")).toBe(true)
  })

  it("deletes a plugin-created local tracking branch but preserves its remote", () => {
    const fixture = gitFixture(); fixtures.push(fixture)
    const store = state()
    git(fixture.root, "branch", "feature/origin", "main")
    git(fixture.root, "push", "origin", "feature/origin")
    git(fixture.root, "branch", "-D", "feature/origin")
    const checkout = resolve(fixture.root, ".worktrees/origin")
    createTrackingWorktree(fixture.root, checkout, "feature/origin")
    store.registerManagedTarget({
      repoRoot: fixture.root,
      branch: "feature/origin",
      checkoutPath: checkout,
      createdOid: git(fixture.root, "rev-parse", "feature/origin"),
      remote: "origin",
      remoteUrl: fixture.origin,
      remoteBranch: "feature/origin",
      ownsLocal: true,
    })
    const job = enqueueCleanup({ store, repoRoot: fixture.root, checkoutPath: checkout, branch: "feature/origin", source: "test" })

    expect(job.deleteLocal).toBe(true)
    expect(job.deleteRemote).toBe(false)
    expect(attemptCleanup(store, job)).toBe(true)
    expect(localBranchExists(fixture.root, "feature/origin")).toBe(false)
    expect(remoteBranchExists(fixture.root, "feature/origin")).toBe(true)
  })

  it("does not infer ownership from the wheels prefix", () => {
    const fixture = gitFixture(); fixtures.push(fixture)
    const store = state()
    git(fixture.root, "branch", "wheels/existing", "main")
    git(fixture.root, "push", "-u", "origin", "wheels/existing")
    const checkout = resolve(fixture.root, ".worktrees/existing")
    createTrackingWorktree(fixture.root, checkout, "wheels/existing")
    const job = enqueueCleanup({ store, repoRoot: fixture.root, checkoutPath: checkout, branch: "wheels/existing", source: "test" })
    expect(job.deleteRemote).toBe(false)
    expect(attemptCleanup(store, job)).toBe(true)
    expect(remoteBranchExists(fixture.root, "wheels/existing")).toBe(true)
  })

  it("revalidates the checkout branch before resuming a persisted phase", () => {
    const fixture = gitFixture(); fixtures.push(fixture)
    const store = state()
    git(fixture.root, "branch", "feature/expected", "main")
    git(fixture.root, "branch", "feature/other", "main")
    const checkout = resolve(fixture.root, ".worktrees/expected")
    createTrackingWorktree(fixture.root, checkout, "feature/expected")
    const job = enqueueCleanup({ store, repoRoot: fixture.root, checkoutPath: checkout, branch: "feature/expected", source: "test" })
    store.saveCleanupJob({ ...job, phase: "checkout" })
    git(checkout, "checkout", "feature/other")

    expect(attemptCleanup(store, { ...job, phase: "checkout" })).toBe(false)
    expect(worktreeForPath(fixture.root, checkout)?.branch).toBe("feature/other")
    expect(localBranchExists(fixture.root, "feature/expected")).toBe(true)
  })

  it("refuses remote deletion after the remote identity changes", () => {
    const fixture = gitFixture(); fixtures.push(fixture)
    const store = state()
    const checkout = resolve(fixture.root, ".worktrees/task")
    createWorktree(fixture.root, checkout, "wheels/task", "main")
    git(checkout, "push", "-u", "origin", "wheels/task")
    store.registerManagedTarget({
      repoRoot: fixture.root,
      branch: "wheels/task",
      checkoutPath: checkout,
      createdOid: git(fixture.root, "rev-parse", "wheels/task"),
      remote: "origin",
      remoteUrl: fixture.origin,
      remoteBranch: "wheels/task",
      ownsLocal: true,
      ownsRemote: true,
    })
    const job = enqueueCleanup({ store, repoRoot: fixture.root, checkoutPath: checkout, branch: "wheels/task", source: "test" })
    git(fixture.root, "remote", "set-url", "origin", resolve(fixture.root, "different-origin.git"))

    expect(attemptCleanup(store, job)).toBe(false)
    expect(localBranchExists(fixture.root, "wheels/task")).toBe(true)
  })

  it("refuses cleanup when the checkout is detached", () => {
    const fixture = gitFixture(); fixtures.push(fixture)
    const store = state()
    git(fixture.root, "branch", "feature/detached", "main")
    const checkout = resolve(fixture.root, ".worktrees/detached")
    createTrackingWorktree(fixture.root, checkout, "feature/detached")
    const job = enqueueCleanup({ store, repoRoot: fixture.root, checkoutPath: checkout, branch: "feature/detached", source: "test" })
    git(checkout, "checkout", "--detach")

    expect(attemptCleanup(store, job)).toBe(false)
    expect(localBranchExists(fixture.root, "feature/detached")).toBe(true)
  })

})
