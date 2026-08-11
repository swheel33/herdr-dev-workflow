import { existsSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { checkoutDirty, defaultBranch, fetchOrigin, remoteBranchExists, tryGit, worktreeForPath } from "./git.js"
import { HerdrClient } from "./herdr.js"
import { canonical } from "./paths.js"
import { run } from "./process.js"
import { StateStore } from "./state.js"

function exactMergedPullRequest(repo: string, branch: string, head: string): boolean {
  const result = run([
    "gh", "pr", "list", "--state", "merged", "--head", branch, "--limit", "20",
    "--json", "mergedAt,headRefName,headRefOid,isCrossRepository",
  ], { cwd: repo, check: false })
  if (result.exitCode) return false
  const prs = JSON.parse(result.stdout) as Array<Record<string, unknown>>
  return prs.some((pr) => pr.mergedAt && pr.headRefName === branch && pr.headRefOid === head && pr.isCrossRepository === false)
}

export function scanMerged(store = new StateStore(), herdr = new HerdrClient()): { checked: number; closed: number; blocked: number } {
  let checked = 0
  let closed = 0
  let blocked = 0
  const openWorkspaces = herdr.workspaces()
  const singleSession = herdr.runningSessionCount() === 1
  for (const target of store.managedTargets()) {
    const repo = String(target.repo_root)
    const checkout = canonical(String(target.checkout_path))
    const branch = String(target.branch)
    try {
      fetchOrigin(repo)
      const baseBranch = defaultBranch(repo)
      const base = remoteBranchExists(repo, baseBranch) ? `origin/${baseBranch}` : baseBranch
      const tree = worktreeForPath(repo, checkout)
      if (!tree?.head || tree.branch !== branch) continue
      checked += 1
      const integrated = tree.head !== String(target.created_oid)
        && tryGit(repo, "merge-base", "--is-ancestor", tree.head, base).ok
      const mergedPullRequest = !integrated && exactMergedPullRequest(repo, branch, tree.head)
      if (!integrated && !mergedPullRequest) continue
      const workspace = openWorkspaces.find((item) => {
        const provenance = item.worktree as Record<string, unknown> | undefined
        return provenance?.checkout_path && canonical(String(provenance.checkout_path)) === checkout
      })
      const reasons: string[] = []
      if (!singleSession) reasons.push("multiple Herdr sessions are running")
      if (!workspace) reasons.push("worktree is not open in this Herdr session")
      else if (workspace.focused === true) reasons.push("workspace is focused")
      else if (!["idle", "done"].includes(String(workspace.agent_status ?? ""))) reasons.push(`agent is ${workspace.agent_status ?? "unknown"}`)
      if (checkoutDirty(checkout)) reasons.push("checkout has uncommitted changes")
      const blockKey = createHash("sha256").update(`${canonical(repo)}\0${checkout}\0${branch}\0${tree.head}`).digest("hex").slice(0, 24)
      if (reasons.length) {
        blocked += 1
        store.log("info", "auto-prune.blocked", JSON.stringify({ repo, checkout, branch, head: tree.head, reasons }))
        if (store.blockAutoPrune({ key: blockKey, repoRoot: repo, checkoutPath: checkout, branch, headOid: tree.head, reasons })) {
          herdr.notify("Merged worktree needs manual cleanup", `${branch}: ${reasons.join(", ")}.`)
        }
        continue
      }
      store.clearAutoPruneBlock(blockKey)
      store.log("info", "auto-prune.closing", JSON.stringify({
        repo, checkout, branch, head: tree.head, mergedBy: integrated ? "default-branch" : "pull-request",
      }))
      try {
        herdr.closeWorkspace(String(workspace!.workspace_id))
        closed += 1
        store.log("info", "auto-prune.closed", JSON.stringify({ repo, checkout, branch, head: tree.head }))
      } catch (error) {
        store.log("error", "auto-prune.close-failed", JSON.stringify({ repo, checkout, branch, error: String(error) }))
      }
    } catch (error) {
      store.log("error", "auto-prune.scan-failed", JSON.stringify({ repo, checkout, branch, error: String(error) }))
      continue
    }
  }
  const result = { checked, closed, blocked }
  store.log("info", "auto-prune.scan", JSON.stringify(result))
  return result
}

export async function watchMerged(store = new StateStore()): Promise<void> {
  const owner = randomUUID()
  const configured = Number(process.env.HERDR_AUTO_PRUNE_INTERVAL_SECONDS ?? 3600)
  const interval = Math.max(60, Number.isFinite(configured) ? configured : 3600) * 1000
  if (!store.acquireLock("auto-prune-watcher", owner, Math.max(interval * 2, 120_000))) return
  try {
    while (!process.env.HERDR_SOCKET_PATH || existsSync(process.env.HERDR_SOCKET_PATH)) {
      if (!store.refreshLock("auto-prune-watcher", owner)) return
      try { scanMerged(store) } catch (error) { store.log("error", "auto-prune.watcher", String(error)) }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, interval))
    }
  } finally {
    store.releaseLock("auto-prune-watcher", owner)
  }
}
