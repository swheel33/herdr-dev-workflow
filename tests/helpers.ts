import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { run } from "../src/process.js"

export interface GitFixture {
  root: string
  origin: string
  dispose(): void
}

export function gitFixture(): GitFixture {
  const root = mkdtempSync(resolve(tmpdir(), "wheels-test-"))
  const origin = resolve(root, "origin.git")
  const primary = resolve(root, "repo")
  run(["git", "init", "--bare", origin])
  run(["git", "init", "-b", "main", primary])
  run(["git", "-C", primary, "config", "user.email", "test@example.com"])
  run(["git", "-C", primary, "config", "user.name", "Test User"])
  run(["git", "-C", primary, "commit", "--allow-empty", "-m", "initial"])
  run(["git", "-C", primary, "remote", "add", "origin", origin])
  run(["git", "-C", primary, "push", "-u", "origin", "main"])
  run(["git", "-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"])
  return {
    root: primary,
    origin,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}
