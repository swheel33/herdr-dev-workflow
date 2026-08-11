import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { WorkflowError } from "./errors.js"
import {
  branchHead,
  createTrackingWorktree,
  createWorktree,
  defaultBaseRef,
  fetchOrigin,
  hasOrigin,
  localBranchExists,
  managedWorktreePath,
  primaryWorktree,
  remoteBranchExists,
  remoteUrl,
  safeWorktreeName,
  slugify,
  synchronizeDefaultBranch,
  worktreeForBranch,
} from "./git.js"
import { HerdrClient } from "./herdr.js"
import { canonical } from "./paths.js"
import type { StateStore, TargetKind } from "./state.js"

export interface PreparedTarget {
  kind: TargetKind
  repoRoot: string
  branch: string
  checkoutPath: string
  label: string
  workspaceId: string
  rootPaneId: string
  shellPaneId: string
}

export interface DispatchTarget {
  kind: TargetKind
  value: string
}

function linkEnvironmentFiles(repo: string, checkout: string): void {
  const primary = primaryWorktree(repo)
  if (!primary || canonical(primary.path) === canonical(checkout)) return
  const apps = resolve(primary.path, "apps")
  if (!existsSync(apps)) return
  for (const app of readdirSync(apps, { withFileTypes: true })) {
    if (!app.isDirectory()) continue
    const source = join(apps, app.name, ".env")
    const destination = join(checkout, relative(primary.path, source))
    if (!existsSync(source) || existsSync(destination)) continue
    mkdirSync(dirname(destination), { recursive: true })
    symlinkSync(source, destination)
  }
}

function resolvePullRequest(repo: string, value: string): string {
  const result = JSON.parse((awaitlessGh(repo, value))) as {
    state?: string
    headRefName?: string
    headRefOid?: string
    isCrossRepository?: boolean
    url?: string
  }
  if (result.state !== "OPEN") throw new WorkflowError(`Pull request is not open: ${value}`)
  if (result.isCrossRepository) throw new WorkflowError("Cross-repository pull requests are not supported yet")
  if (!result.headRefName || !result.headRefOid) throw new WorkflowError(`Pull request has no usable head: ${value}`)
  const repositoryUrl = awaitlessGhRepository(repo).replace(/\/$/, "")
  if (!result.url?.startsWith(`${repositoryUrl}/pull/`)) {
    throw new WorkflowError(`Pull request does not belong to the current repository: ${value}`)
  }
  fetchOrigin(repo)
  const remoteOid = remoteBranchExists(repo, result.headRefName)
    ? (awaitlessGit(repo, "rev-parse", `refs/remotes/origin/${result.headRefName}`))
    : ""
  if (remoteOid !== result.headRefOid) throw new WorkflowError(`Pull request head changed or is unavailable on origin: ${value}`)
  return result.headRefName
}

function awaitlessGh(repo: string, value: string): string {
  const { run } = requireProcess()
  return run([
    "gh", "pr", "view", value,
    "--json", "state,headRefName,headRefOid,isCrossRepository,url",
  ], { cwd: repo }).stdout
}

function awaitlessGhRepository(repo: string): string {
  const { run } = requireProcess()
  return run(["gh", "repo", "view", "--json", "url", "--jq", ".url"], { cwd: repo }).stdout.trim()
}

function awaitlessGit(repo: string, ...args: string[]): string {
  const { run } = requireProcess()
  return run(["git", "-C", repo, ...args]).stdout.trim()
}

function requireProcess(): typeof import("./process.js") {
  // Kept as one indirection so target-resolution tests can replace process execution.
  return processModule
}

import * as processModule from "./process.js"

export function prepareTarget(input: {
  repoRoot: string
  target: DispatchTarget
  store: StateStore
  herdr: HerdrClient
}): PreparedTarget {
  const repo = canonical(input.repoRoot)
  input.store.rememberRepository(repo)
  let branch = ""
  let checkout = ""
  let opened: ReturnType<HerdrClient["openWorktree"]>
    if (input.target.kind === "new") {
      const slug = slugify(input.target.value)
      branch = `wheels/${slug}`
      checkout = managedWorktreePath(repo, slug)
      const sync = synchronizeDefaultBranch(repo)
      if (["dirty", "diverged"].includes(sync)) throw new WorkflowError(`Default branch synchronization blocked: ${sync}`)
      if (localBranchExists(repo, branch) || remoteBranchExists(repo, branch)) {
        throw new WorkflowError(`Branch already exists; dispatch it as an existing branch instead: ${branch}`)
      }
      createWorktree(repo, checkout, branch, defaultBaseRef(repo))
      input.store.registerManagedTarget({
        repoRoot: repo,
        branch,
        checkoutPath: checkout,
        createdOid: branchHead(repo, branch),
        ownsLocal: true,
        ...(hasOrigin(repo) ? { remote: "origin", remoteUrl: remoteUrl(repo), remoteBranch: branch, ownsRemote: true } : {}),
      })
    } else {
      branch = input.target.kind === "pr" ? resolvePullRequest(repo, input.target.value) : input.target.value.trim().replace(/^origin\//, "")
      if (!branch) throw new WorkflowError("Existing branch target must not be empty")
      fetchOrigin(repo)
      const existing = worktreeForBranch(repo, branch)
      const primary = primaryWorktree(repo)
      if (existing && primary && canonical(existing.path) === canonical(primary.path)) {
        throw new WorkflowError(`Refusing to dispatch into the primary checkout: ${branch}`)
      }
      let ownsLocal = false
      if (existing) {
        checkout = existing.path
        ownsLocal = Number(input.store.managedTarget(repo, branch)?.owns_local ?? 0) === 1
      } else {
        checkout = managedWorktreePath(repo, safeWorktreeName(branch))
        const tracking = createTrackingWorktree(repo, checkout, branch)
        ownsLocal = tracking.createdLocalBranch
      }
      input.store.registerManagedTarget({
        repoRoot: repo,
        branch,
        checkoutPath: checkout,
        createdOid: branchHead(repo, branch),
        ownsLocal,
        ...(hasOrigin(repo) ? { remote: "origin", remoteUrl: remoteUrl(repo), remoteBranch: branch } : {}),
      })
    }

  const label = basename(checkout)
  linkEnvironmentFiles(repo, checkout)
  opened = input.herdr.openWorktree(repo, checkout, label)
  const panes = input.herdr.panes(opened.workspaceId)
  const workspace = input.herdr.workspaces().find((item) => item.workspace_id === opened.workspaceId)
  if (!workspace || !["idle", "done"].includes(String(workspace.agent_status ?? ""))) {
    throw new WorkflowError(`Target workspace agent is not idle in ${branch}`)
  }
  const shellPaneId = panes.length > 1
    ? String(panes.find((pane) => String(pane.pane_id) !== opened.rootPaneId)?.pane_id ?? "")
    : input.herdr.splitPane(opened.rootPaneId, checkout)
  if (!shellPaneId) throw new WorkflowError("Could not identify the target shell pane")
  input.herdr.runInstall(shellPaneId, checkout)
  return {
    kind: input.target.kind,
    repoRoot: repo,
    branch,
    checkoutPath: checkout,
    label,
    workspaceId: opened.workspaceId,
    rootPaneId: opened.rootPaneId,
    shellPaneId,
  }
}

export function validateDestination(path: string): void {
  if (!existsSync(path)) return
  if (lstatSync(path).isSymbolicLink()) throw new WorkflowError(`Worktree destination must not be a symbolic link: ${path}`)
}
