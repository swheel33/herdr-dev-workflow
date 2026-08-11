import { describe, expect, it } from "vitest"
import { createTrackingWorktree, defaultBranch, git, slugify } from "../src/git.js"
import { resolve } from "node:path"
import { gitFixture } from "./helpers.js"

describe("repository targeting", () => {
  it("uses origin HEAD as the default branch", () => {
    const fixture = gitFixture()
    try { expect(defaultBranch(fixture.root)).toBe("main") } finally { fixture.dispose() }
  })

  it("prefers a conventional default over the primary checkout's feature branch", () => {
    const fixture = gitFixture()
    try {
      git(fixture.root, "checkout", "-b", "feature/current")
      expect(defaultBranch(fixture.root)).toBe("main")
    } finally { fixture.dispose() }
  })

  it("rejects path-like or empty task slugs", () => {
    expect(() => slugify("...")) .toThrow()
    expect(() => slugify("   ")).toThrow()
    expect(slugify("Fix Sign-In!")) .toBe("fix-sign-in")
  })

  it("opens either a pre-existing local branch or an origin branch", () => {
    const fixture = gitFixture()
    try {
      git(fixture.root, "branch", "feature/local", "main")
      createTrackingWorktree(fixture.root, resolve(fixture.root, ".worktrees/local"), "feature/local")
      git(fixture.root, "worktree", "remove", "--force", resolve(fixture.root, ".worktrees/local"))
      git(fixture.root, "branch", "feature/remote", "main")
      git(fixture.root, "push", "origin", "feature/remote")
      git(fixture.root, "branch", "-D", "feature/remote")
      createTrackingWorktree(fixture.root, resolve(fixture.root, ".worktrees/remote"), "feature/remote")
    } finally { fixture.dispose() }
  })
})
