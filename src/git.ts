import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { CommandError, WorkflowError } from "./errors.js"
import { canonical } from "./paths.js"
import { run } from "./process.js"

export interface WorktreeRecord {
  path: string
  branch?: string
  head?: string
  locked: boolean
  bare: boolean
}

export function git(repo: string, ...args: string[]): string {
  return run(["git", "-C", repo, ...args]).stdout.trim()
}

export function tryGit(repo: string, ...args: string[]): { ok: boolean; stdout: string; stderr: string; exitCode: number } {
  const result = run(["git", "-C", repo, ...args], { check: false })
  return { ok: result.exitCode === 0, ...result }
}

export function primaryRepository(path: string): string | null {
  const common = tryGit(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
  if (!common.ok || !common.stdout.trim()) return null
  const bare = tryGit(path, "rev-parse", "--is-bare-repository")
  return canonical(bare.ok && bare.stdout.trim() === "true" ? common.stdout.trim() : dirname(common.stdout.trim()))
}

export function worktrees(repo: string): WorktreeRecord[] {
  const output = git(repo, "worktree", "list", "--porcelain")
  const records: WorktreeRecord[] = []
  let current: WorktreeRecord | undefined
  for (const line of `${output}\n\n`.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current)
      current = { path: canonical(line.slice(9)), locked: false, bare: false }
    } else if (!line && current) {
      records.push(current)
      current = undefined
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice(18)
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice(5)
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true
    } else if (current && line === "bare") {
      current.bare = true
    }
  }
  return records
}

export function primaryWorktree(repo: string): WorktreeRecord | null {
  return worktrees(repo)[0] ?? null
}

export function worktreeForBranch(repo: string, branch: string): WorktreeRecord | null {
  return worktrees(repo).find((record) => record.branch === branch) ?? null
}

export function worktreeForPath(repo: string, path: string): WorktreeRecord | null {
  const expected = canonical(path)
  return worktrees(repo).find((record) => canonical(record.path) === expected) ?? null
}

export function hasOrigin(repo: string): boolean {
  return tryGit(repo, "remote", "get-url", "origin").ok
}

export function remoteUrl(repo: string, remote = "origin"): string {
  return git(repo, "remote", "get-url", remote)
}

export function fetchOrigin(repo: string): void {
  if (hasOrigin(repo)) git(repo, "fetch", "origin", "--prune")
}

export function localBranchExists(repo: string, branch: string): boolean {
  return tryGit(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).ok
}

export function remoteBranchExists(repo: string, branch: string): boolean {
  return tryGit(repo, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`).ok
}

export function defaultBranch(repo: string): string {
  const symbolic = tryGit(repo, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
  if (symbolic.ok) return symbolic.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
  for (const candidate of ["main", "master", "develop"]) {
    if (localBranchExists(repo, candidate)) return candidate
  }
  const primary = primaryWorktree(repo)
  if (primary?.branch) return primary.branch
  const current = tryGit(repo, "branch", "--show-current").stdout.trim()
  if (current) return current
  throw new WorkflowError(`Could not determine the default branch for ${repo}`)
}

export function defaultBaseRef(repo: string): string {
  const branch = defaultBranch(repo)
  return remoteBranchExists(repo, branch) ? `origin/${branch}` : branch
}

export function protectedBranches(repo: string, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const protectedSet = new Set(["main", "master", defaultBranch(repo)])
  for (const branch of (env.HERDR_PROTECTED_BRANCHES ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    protectedSet.add(branch)
  }
  return protectedSet
}

export function slugify(value: string): string {
  const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-")
  if (!slug || slug === "." || slug === "..") throw new WorkflowError("Target name must contain a letter or number")
  return slug
}

export function safeWorktreeName(branch: string): string {
  const slug = slugify(branch).slice(0, 48)
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 8)
  return `${slug}-${hash}`
}

export function managedWorktreePath(repo: string, name: string): string {
  return resolve(repo, ".worktrees", name)
}

export function createWorktree(repo: string, checkout: string, branch: string, base: string): void {
  if (existsSync(checkout)) throw new WorkflowError(`Worktree path already exists: ${checkout}`)
  git(repo, "worktree", "add", "-b", branch, checkout, base)
}

export function createTrackingWorktree(repo: string, checkout: string, branch: string): { createdLocalBranch: boolean } {
  if (existsSync(checkout)) throw new WorkflowError(`Worktree path already exists: ${checkout}`)
  if (localBranchExists(repo, branch)) {
    git(repo, "worktree", "add", checkout, branch)
    return { createdLocalBranch: false }
  } else if (remoteBranchExists(repo, branch)) {
    git(repo, "worktree", "add", "-b", branch, checkout, `origin/${branch}`)
    return { createdLocalBranch: true }
  } else {
    throw new WorkflowError(`Branch does not exist locally or on origin: ${branch}`)
  }
}

export function removeWorktree(repo: string, checkout: string): void {
  const record = worktreeForPath(repo, checkout)
  if (!record) {
    if (existsSync(checkout)) throw new WorkflowError(`Path exists without matching Git worktree metadata: ${checkout}`)
    return
  }
  if (record.locked) git(repo, "worktree", "unlock", checkout)
  git(repo, "worktree", "remove", "--force", checkout)
}

export function deleteLocalBranch(repo: string, branch: string): void {
  if (localBranchExists(repo, branch)) git(repo, "branch", "-D", branch)
}

export function deleteRemoteBranch(repo: string, remote: string, branch: string, expectedRemoteUrl: string): void {
  const currentRemoteUrl = remoteUrl(repo, remote)
  if (currentRemoteUrl !== expectedRemoteUrl) {
    throw new WorkflowError(`Remote ${remote} changed; expected ${expectedRemoteUrl}, found ${currentRemoteUrl}`)
  }
  const exists = run(["git", "-C", repo, "ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`], { check: false })
  if (exists.exitCode === 0) git(repo, "push", remote, "--delete", branch)
  else if (exists.exitCode !== 2) throw new CommandError(["git", "-C", repo, "ls-remote"], exists.exitCode, exists.stdout, exists.stderr)
}

export function branchHead(repo: string, branch: string): string {
  return git(repo, "rev-parse", `refs/heads/${branch}`)
}

export function checkoutDirty(checkout: string): boolean {
  return Boolean(git(checkout, "status", "--porcelain", "--untracked-files=all"))
}

export function synchronizeDefaultBranch(repo: string): "no_remote" | "current" | "updated" | "dirty" | "ahead" | "diverged" | "not_primary" {
  if (!hasOrigin(repo)) return "no_remote"
  fetchOrigin(repo)
  const branch = defaultBranch(repo)
  const localRef = `refs/heads/${branch}`
  const remoteRef = `refs/remotes/origin/${branch}`
  if (!localBranchExists(repo, branch) || !remoteBranchExists(repo, branch)) return "current"
  const primary = primaryWorktree(repo)
  if (!primary || primary.branch !== branch) return "not_primary"
  const localOid = git(repo, "rev-parse", localRef)
  const remoteOid = git(repo, "rev-parse", remoteRef)
  if (localOid === remoteOid) return "current"
  if (checkoutDirty(primary.path)) return "dirty"
  const localAncestor = tryGit(repo, "merge-base", "--is-ancestor", localRef, remoteRef)
  if (localAncestor.ok) {
    git(primary.path, "merge", "--ff-only", remoteRef)
    return "updated"
  }
  return tryGit(repo, "merge-base", "--is-ancestor", remoteRef, localRef).ok ? "ahead" : "diverged"
}

export function labelForCheckout(path: string): string {
  return basename(path) || "worktree"
}
