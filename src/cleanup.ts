import { createHash } from "node:crypto"
import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import { CommandError, WorkflowError } from "./errors.js"
import {
  deleteLocalBranch,
  deleteRemoteBranch,
  git,
  primaryWorktree,
  protectedBranches,
  removeWorktree,
  worktreeForBranch,
  worktreeForPath,
} from "./git.js"
import { HerdrClient } from "./herdr.js"
import { canonical } from "./paths.js"
import { type CleanupJob, StateStore } from "./state.js"

function cleanupId(repo: string, checkout: string, branch: string): string {
  return createHash("sha256").update(`${canonical(repo)}\0${canonical(checkout)}\0${branch}`).digest("hex").slice(0, 24)
}

function errorRecord(error: unknown): string {
  if (error instanceof CommandError) {
    return JSON.stringify({
      message: error.message,
      command: error.command,
      exitCode: error.exitCode,
      stdout: error.stdout,
      stderr: error.stderr,
    })
  }
  return JSON.stringify({ message: error instanceof Error ? error.message : String(error) })
}

export function enqueueCleanup(input: {
  store: StateStore
  repoRoot: string
  checkoutPath: string
  branch: string
  source: string
  label?: string
  eventKey?: string
}): CleanupJob {
  const repoRoot = canonical(input.repoRoot)
  const checkoutPath = canonical(input.checkoutPath)
  const managed = input.store.managedTarget(repoRoot, input.branch)
  const targetMatches = managed !== null && String(managed.checkout_path) === checkoutPath
  const ownsRemote = targetMatches && Number(managed.owns_remote) === 1 && Boolean(managed.remote_url)
  const job: CleanupJob = {
    id: cleanupId(repoRoot, checkoutPath, input.branch),
    repoRoot,
    checkoutPath,
    branch: input.branch,
    label: input.label ?? basename(checkoutPath),
    source: input.source,
    eventKey: input.eventKey ?? null,
    phase: "validate",
    deleteRemote: ownsRemote,
    deleteLocal: targetMatches && Number(managed.owns_local) === 1,
    remote: ownsRemote && managed?.remote ? String(managed.remote) : null,
    remoteUrl: ownsRemote && managed?.remote_url ? String(managed.remote_url) : null,
    remoteBranch: ownsRemote && managed?.remote_branch ? String(managed.remote_branch) : null,
    error: null,
  }
  input.store.saveCleanupJob(job)
  return job
}

function validate(job: CleanupJob): void {
  if (!job.branch) throw new WorkflowError("Cleanup stopped because branch metadata is missing")
  const primary = primaryWorktree(job.repoRoot)
  if (primary && canonical(primary.path) === canonical(job.checkoutPath)) {
    throw new WorkflowError(`Refusing to remove primary checkout ${job.checkoutPath}`)
  }
  const protectedSet = protectedBranches(job.repoRoot)
  if (protectedSet.has(job.branch) || (job.remoteBranch && protectedSet.has(job.remoteBranch))) {
    throw new WorkflowError(`Refusing to remove protected branch ${job.branch}`)
  }
  if (job.deleteRemote && job.remote && job.remoteUrl) {
    const currentRemoteUrl = git(job.repoRoot, "remote", "get-url", job.remote)
    if (currentRemoteUrl !== job.remoteUrl) {
      throw new WorkflowError(`Remote ${job.remote} changed; refusing remote branch deletion`)
    }
  }
  const current = worktreeForPath(job.repoRoot, job.checkoutPath)
  if (current && current.branch !== job.branch) {
    throw new WorkflowError(`Worktree branch mismatch: expected ${job.branch}, found ${current.branch ?? "detached HEAD"}`)
  }
  const branchCheckout = worktreeForBranch(job.repoRoot, job.branch)
  if (branchCheckout && canonical(branchCheckout.path) !== canonical(job.checkoutPath)) {
    throw new WorkflowError(`Branch ${job.branch} is checked out at a different path: ${branchCheckout.path}`)
  }
}

export function attemptCleanup(store: StateStore, initial: CleanupJob): boolean {
  const owner = randomUUID()
  const lockKey = `cleanup:${canonical(initial.repoRoot)}`
  if (!store.acquireLock(lockKey, owner)) return false
  let job = initial
  try {
    while (true) {
      if (job.phase !== "prune") validate(job)
      if (job.phase === "validate") {
        job = { ...job, phase: "remote", error: null }
      } else if (job.phase === "remote") {
        if (job.deleteRemote && job.remote && job.remoteUrl && job.remoteBranch) {
          deleteRemoteBranch(job.repoRoot, job.remote, job.remoteBranch, job.remoteUrl)
        }
        job = { ...job, phase: "checkout", error: null }
      } else if (job.phase === "checkout") {
        removeWorktree(job.repoRoot, job.checkoutPath)
        job = { ...job, phase: "branch", error: null }
      } else if (job.phase === "branch") {
        if (job.deleteLocal) deleteLocalBranch(job.repoRoot, job.branch)
        job = { ...job, phase: "prune", error: null }
      } else {
        git(job.repoRoot, "worktree", "prune", "--expire", "now")
        store.transaction(() => {
          store.deleteCleanupJob(job.id)
          store.deleteManagedTarget(job.repoRoot, job.branch)
          store.releaseDispatchTargets(job.repoRoot, job.branch)
          if (job.eventKey) store.markEventComplete(job.eventKey)
        })
        store.log("info", "cleanup.completed", JSON.stringify({
          repo: job.repoRoot, checkout: job.checkoutPath, branch: job.branch, source: job.source,
        }))
        return true
      }
      store.saveCleanupJob(job)
    }
  } catch (error) {
    store.saveCleanupJob({ ...job, error: errorRecord(error) })
    store.log("error", "cleanup.failed", JSON.stringify({
      repo: job.repoRoot, checkout: job.checkoutPath, branch: job.branch, phase: job.phase,
      error: error instanceof Error ? error.message : String(error),
    }))
    return false
  } finally {
    store.releaseLock(lockKey, owner)
  }
}

export function retryCleanup(store: StateStore, herdr = new HerdrClient()): number {
  let failures = 0
  for (const job of store.cleanupJobs()) {
    if (!attemptCleanup(store, job)) failures += 1
  }
  if (failures) herdr.notify("Worktree cleanup failures remain", `${failures} cleanup job(s) require attention.`)
  return failures
}

function eventMetadata(env: NodeJS.ProcessEnv): {
  repoRoot: string
  checkoutPath: string
  branch: string
  label: string
  eventKey: string
} | null {
  const envelope = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON ?? "{}") as Record<string, any>
  const event = env.HERDR_PLUGIN_EVENT ?? envelope.event
  const data = envelope.data ?? {}
  const workspace = data.workspace ?? {}
  const provenance = workspace.worktree ?? {}
  let context: Record<string, any> = {}
  try { context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}") as Record<string, any> } catch { /* validated below */ }
  const contextProvenance = context.worktree ?? {}
  if (event === "workspace.closed") {
    if (!provenance.is_linked_worktree) return null
    return {
      repoRoot: provenance.repo_root ?? contextProvenance.repo_root,
      checkoutPath: provenance.checkout_path,
      branch: data.worktree?.branch ?? provenance.branch ?? "",
      label: workspace.label ?? "worktree",
      eventKey: data.workspace_id ?? workspace.workspace_id ?? "",
    }
  }
  if (event === "worktree.removed") {
    const tree = data.worktree ?? {}
    if (!tree.is_linked_worktree) return null
    if (provenance.checkout_path && canonical(provenance.checkout_path) !== canonical(tree.path)) {
      throw new WorkflowError("Event workspace and worktree paths do not match")
    }
    return {
      repoRoot: provenance.repo_root ?? contextProvenance.repo_root,
      checkoutPath: tree.path,
      branch: tree.branch ?? "",
      label: tree.label ?? workspace.label ?? "worktree",
      eventKey: data.workspace_id ?? workspace.workspace_id ?? "",
    }
  }
  return null
}

export function handleCleanupEvent(store: StateStore, env: NodeJS.ProcessEnv = process.env): number {
  const metadata = eventMetadata(env)
  if (!metadata) return 0
  if (!metadata.repoRoot || !metadata.checkoutPath) throw new WorkflowError("Linked-worktree event metadata is incomplete")
  if (store.eventCompleted(metadata.eventKey)) return 0
  if (!metadata.branch) metadata.branch = worktreeForPath(metadata.repoRoot, metadata.checkoutPath)?.branch ?? ""
  const existing = store.cleanupJobs().find((job) => job.eventKey === metadata.eventKey || (
    job.repoRoot === canonical(metadata.repoRoot) && job.checkoutPath === canonical(metadata.checkoutPath)
  ))
  if (!metadata.branch && existing) return attemptCleanup(store, existing) ? 0 : 1
  const job = enqueueCleanup({ store, ...metadata, source: env.HERDR_PLUGIN_EVENT ?? "event" })
  return attemptCleanup(store, job) ? 0 : 1
}

export function cleanupReport(store: StateStore): string {
  const jobs = store.cleanupJobs()
  if (!jobs.length) return "No pending worktree cleanup failures."
  return jobs.map((job) => [
    `${job.label} [${job.phase}]`,
    `  repo: ${job.repoRoot}`,
    `  path: ${job.checkoutPath}`,
    `  branch: ${job.branch || "(missing)"}`,
    `  local branch deletion: ${job.deleteLocal ? "enabled" : "preserved"}`,
    `  remote deletion: ${job.deleteRemote ? `${job.remote}/${job.remoteBranch}` : "preserved"}`,
    `  error: ${job.error ?? "pending retry"}`,
  ].join("\n")).join("\n\n")
}
