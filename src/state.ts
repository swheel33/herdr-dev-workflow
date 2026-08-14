import { mkdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { slugify, worktreeForPath } from "./git.js"
import { canonical, stateDirectory } from "./paths.js"

export type CleanupPhase = "validate" | "remote" | "checkout" | "branch" | "prune"
export type DispatchStatus = "preparing" | "delivered" | "delivery_unknown" | "pre_prompt_failed"
export type TargetKind = "new" | "branch" | "pr"

export interface DispatchRecord {
  id: string
  sourceSessionId: string
  sourceMessageId: string
  projectRoot: string
  targetKind: TargetKind
  targetValue: string
  targetKey: string
  requestHash: string | null
  branch: string | null
  checkoutPath: string | null
  implementationSessionId: string | null
  status: DispatchStatus
  error: string | null
  runnerStartedAt: number | null
  runnerPid: number | null
  createdAt: number
  updatedAt: number
}

export function dispatchTargetKey(kind: TargetKind, value: string, branch?: string | null): string {
  if (branch) return `branch:${branch}`
  if (kind === "new") return `branch:wheels/${slugify(value)}`
  if (kind === "branch") return `branch:${value.trim().replace(/^origin\//, "")}`
  return `pr:${value.trim().toLowerCase()}`
}

export interface ProjectHub {
  projectRoot: string
  paneId: string
  tabId: string
  workspaceId: string
  herdrBin: string
  socketPath: string | null
}

export interface CleanupJob {
  id: string
  repoRoot: string
  checkoutPath: string
  branch: string
  label: string
  source: string
  eventKey: string | null
  phase: CleanupPhase
  deleteRemote: boolean
  deleteLocal: boolean
  remote: string | null
  remoteUrl: string | null
  remoteBranch: string | null
  error: string | null
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
CREATE TABLE IF NOT EXISTS repositories (
  root TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS managed_targets (
  repo_root TEXT NOT NULL,
  branch TEXT NOT NULL,
  checkout_path TEXT NOT NULL,
  created_oid TEXT NOT NULL,
  remote TEXT,
  remote_url TEXT,
  remote_branch TEXT,
  owns_local INTEGER NOT NULL DEFAULT 1,
  owns_remote INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_root, branch)
);
CREATE TABLE IF NOT EXISTS cleanup_jobs (
  id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  checkout_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  event_key TEXT,
  phase TEXT NOT NULL,
  delete_remote INTEGER NOT NULL DEFAULT 0,
  delete_local INTEGER NOT NULL DEFAULT 0,
  remote TEXT,
  remote_url TEXT,
  remote_branch TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(repo_root, checkout_path, branch)
);
CREATE TABLE IF NOT EXISTS event_completions (
  event_key TEXT PRIMARY KEY,
  completed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dispatches (
  dispatch_id TEXT,
  source_session_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  request TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_value TEXT NOT NULL,
  target_key TEXT,
  request_hash TEXT,
  branch TEXT,
  checkout_path TEXT,
  implementation_session_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  runner_started_at INTEGER,
  runner_pid INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(source_session_id, source_message_id)
);
CREATE TABLE IF NOT EXISTS dispatch_target_claims (
  project_root TEXT NOT NULL,
  target_key TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(project_root, target_key)
);
DROP TABLE IF EXISTS project_chats;
CREATE TABLE IF NOT EXISTS project_hubs (
  project_root TEXT PRIMARY KEY,
  pane_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  herdr_bin TEXT NOT NULL,
  socket_path TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auto_prune_blocks (
  key TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  checkout_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  reasons TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locks (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
);
`

export class StateStore {
  readonly database: DatabaseSync

  constructor(path = resolve(stateDirectory(), "workflow.sqlite")) {
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec("PRAGMA busy_timeout = 5000")
    this.database.exec(SCHEMA)
    for (const [table, column, definition] of [
      ["managed_targets", "remote_url", "TEXT"],
      ["managed_targets", "owns_local", "INTEGER NOT NULL DEFAULT 1"],
      ["cleanup_jobs", "remote_url", "TEXT"],
      ["cleanup_jobs", "delete_local", "INTEGER NOT NULL DEFAULT 0"],
      ["dispatches", "dispatch_id", "TEXT"],
      ["dispatches", "target_key", "TEXT"],
      ["dispatches", "request_hash", "TEXT"],
      ["dispatches", "runner_started_at", "INTEGER"],
      ["dispatches", "runner_pid", "INTEGER"],
    ]) {
      const exists = this.database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
      if (!exists) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
    this.database.exec(`
      UPDATE dispatches SET dispatch_id = 'legacy-' || rowid WHERE dispatch_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS dispatches_dispatch_id ON dispatches(dispatch_id);
    `)
    this.transaction(() => {
      for (const row of this.database.prepare("SELECT * FROM dispatches WHERE target_key IS NULL").all()) {
        const key = dispatchTargetKey(
          String(row.target_kind) as TargetKind,
          String(row.target_value),
          row.branch === null ? null : String(row.branch),
        )
        this.database.prepare("UPDATE dispatches SET target_key = ? WHERE dispatch_id = ?")
          .run(key, String(row.dispatch_id))
        if (String(row.status) === "preparing" && row.implementation_session_id !== null) {
          this.database.prepare(`
            UPDATE dispatches SET status = 'delivery_unknown', error = ? WHERE dispatch_id = ?
          `).run("Migrated from legacy preparing state after an implementation session was created; prompt delivery is unknown.", String(row.dispatch_id))
        }
        let shouldClaim = String(row.status) !== "delivered"
        if (!shouldClaim && row.checkout_path !== null && row.branch !== null) {
          try {
            shouldClaim = worktreeForPath(String(row.project_root), String(row.checkout_path))?.branch === String(row.branch)
          } catch { /* a missing historical repository has no active target to claim */ }
        }
        if (shouldClaim) {
          this.database.prepare(`
            INSERT OR IGNORE INTO dispatch_target_claims(project_root, target_key, dispatch_id, created_at)
            VALUES (?, ?, ?, ?)
          `).run(String(row.project_root), key, String(row.dispatch_id), Number(row.created_at))
        }
      }
    })
  }

  close(): void {
    this.database.close()
  }

  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const result = operation()
      this.database.exec("COMMIT")
      return result
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  rememberRepository(root: string): void {
    this.database.prepare(`
      INSERT INTO repositories(root, updated_at) VALUES (?, ?)
      ON CONFLICT(root) DO UPDATE SET updated_at = excluded.updated_at
    `).run(canonical(root), Date.now())
  }

  repositories(): string[] {
    return this.database.prepare("SELECT root FROM repositories ORDER BY root").all().map((row) => String(row.root))
  }

  registerHub(context: ProjectHub): void {
    this.database.prepare(`
      INSERT OR REPLACE INTO project_hubs(
        project_root, pane_id, tab_id, workspace_id, herdr_bin, socket_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      canonical(context.projectRoot),
      context.paneId,
      context.tabId,
      context.workspaceId,
      context.herdrBin,
      context.socketPath,
      Date.now(),
    )
  }

  hub(projectRoot: string): ProjectHub | null {
    const row = this.database.prepare("SELECT * FROM project_hubs WHERE project_root = ?").get(canonical(projectRoot))
    if (!row) return null
    return {
      projectRoot: String(row.project_root),
      paneId: String(row.pane_id),
      tabId: String(row.tab_id),
      workspaceId: String(row.workspace_id),
      herdrBin: String(row.herdr_bin),
      socketPath: row.socket_path === null ? null : String(row.socket_path),
    }
  }

  async waitForHub(projectRoot: string, previousPaneId?: string, timeout = 10_000): Promise<ProjectHub> {
    const deadline = Date.now() + timeout
    do {
      const hub = this.hub(projectRoot)
      if (hub && hub.paneId !== previousPaneId) return hub
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    } while (Date.now() < deadline)
    throw new Error(`Project Chat hub did not start for ${canonical(projectRoot)}`)
  }

  deleteHub(projectRoot: string, paneId?: string): void {
    const query = paneId
      ? "DELETE FROM project_hubs WHERE project_root = ? AND pane_id = ?"
      : "DELETE FROM project_hubs WHERE project_root = ?"
    this.database.prepare(query).run(...(paneId ? [canonical(projectRoot), paneId] : [canonical(projectRoot)]))
  }

  private dispatchRecord(row: Record<string, unknown>): DispatchRecord {
    return {
      id: String(row.dispatch_id),
      sourceSessionId: String(row.source_session_id),
      sourceMessageId: String(row.source_message_id),
      projectRoot: String(row.project_root),
      targetKind: String(row.target_kind) as TargetKind,
      targetValue: String(row.target_value),
      targetKey: String(row.target_key),
      requestHash: row.request_hash === null ? null : String(row.request_hash),
      branch: row.branch === null ? null : String(row.branch),
      checkoutPath: row.checkout_path === null ? null : String(row.checkout_path),
      implementationSessionId: row.implementation_session_id === null ? null : String(row.implementation_session_id),
      status: String(row.status) as DispatchStatus,
      error: row.error === null ? null : String(row.error),
      runnerStartedAt: row.runner_started_at === null ? null : Number(row.runner_started_at),
      runnerPid: row.runner_pid === null ? null : Number(row.runner_pid),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  beginDispatch(input: {
    id: string
    sourceSessionId: string
    sourceMessageId: string
    projectRoot: string
    request: string
    targetKind: TargetKind
    targetValue: string
    targetKey: string
    requestHash: string
  }): { dispatch: DispatchRecord; created: boolean } {
    return this.transaction(() => {
      const projectRoot = canonical(input.projectRoot)
      const source = this.database.prepare(
        "SELECT * FROM dispatches WHERE source_session_id = ? AND source_message_id = ?",
      ).get(input.sourceSessionId, input.sourceMessageId)
      if (source) return { dispatch: this.dispatchRecord(source), created: false }

      const claimed = this.database.prepare(`
        SELECT dispatches.* FROM dispatch_target_claims
        JOIN dispatches USING(dispatch_id)
        WHERE dispatch_target_claims.project_root = ? AND dispatch_target_claims.target_key = ?
      `).get(projectRoot, input.targetKey)
      if (claimed) return { dispatch: this.dispatchRecord(claimed), created: false }

      const now = Date.now()
      this.database.prepare(`
        INSERT INTO dispatches(
          dispatch_id, source_session_id, source_message_id, project_root, request, target_kind, target_value,
          target_key, request_hash, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)
      `).run(
        input.id, input.sourceSessionId, input.sourceMessageId, projectRoot, input.request,
        input.targetKind, input.targetValue, input.targetKey, input.requestHash, now, now,
      )
      this.database.prepare(`
        INSERT INTO dispatch_target_claims(project_root, target_key, dispatch_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(projectRoot, input.targetKey, input.id, now)
      return { dispatch: this.dispatch(input.id)!, created: true }
    })
  }

  dispatch(id: string): DispatchRecord | null {
    const row = this.database.prepare("SELECT * FROM dispatches WHERE dispatch_id = ?").get(id)
    return row ? this.dispatchRecord(row) : null
  }

  dispatches(projectRoot?: string): DispatchRecord[] {
    const rows = projectRoot
      ? this.database.prepare("SELECT * FROM dispatches WHERE project_root = ? ORDER BY created_at DESC").all(canonical(projectRoot))
      : this.database.prepare("SELECT * FROM dispatches ORDER BY created_at DESC").all()
    return rows.map((row) => this.dispatchRecord(row))
  }

  resumeDispatch(id: string, requestHash: string): boolean {
    return this.database.prepare(`
      UPDATE dispatches SET status = 'preparing', error = NULL, request_hash = COALESCE(request_hash, ?),
        runner_started_at = NULL, runner_pid = NULL, updated_at = ?
      WHERE dispatch_id = ? AND status = 'pre_prompt_failed' AND (request_hash IS NULL OR request_hash = ?)
    `).run(requestHash, Date.now(), id, requestHash).changes === 1
  }

  adoptDispatchRequest(id: string, requestHash: string): boolean {
    return this.database.prepare(`
      UPDATE dispatches SET request_hash = ?, updated_at = ?
      WHERE dispatch_id = ? AND status = 'preparing' AND request_hash IS NULL
    `).run(requestHash, Date.now(), id).changes === 1
  }

  failDispatchStart(id: string, error: string): void {
    this.database.prepare(`
      UPDATE dispatches SET status = 'pre_prompt_failed', error = ?, updated_at = ?
      WHERE dispatch_id = ? AND status = 'preparing' AND runner_pid IS NULL
    `).run(error, Date.now(), id)
  }

  claimDispatchRun(id: string, pid: number): boolean {
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT status, runner_pid FROM dispatches WHERE dispatch_id = ?
      `).get(id)
      if (!row || String(row.status) !== "preparing") return false
      if (row.runner_pid !== null) {
        if (Number(row.runner_pid) === pid) return false
        const command = spawnSync("ps", ["-p", String(row.runner_pid), "-o", "command="], { encoding: "utf8" })
        if (command.status === 0 && command.stdout.includes(`dispatch-run ${id}`)) return false
      }
      return this.database.prepare(`
        UPDATE dispatches SET runner_started_at = ?, runner_pid = ?, updated_at = ? WHERE dispatch_id = ?
      `).run(Date.now(), pid, Date.now(), id).changes === 1
    })
  }

  updateDispatch(id: string, fields: {
    status: DispatchStatus
    branch?: string
    checkoutPath?: string
    implementationSessionId?: string
    error?: string
  }): void {
    this.database.prepare(`
      UPDATE dispatches SET status = ?, branch = COALESCE(?, branch), checkout_path = COALESCE(?, checkout_path),
        implementation_session_id = COALESCE(?, implementation_session_id), error = ?,
        runner_pid = CASE WHEN ? = 'preparing' THEN runner_pid ELSE NULL END, updated_at = ?
      WHERE dispatch_id = ?
    `).run(
      fields.status,
      fields.branch ?? null,
      fields.checkoutPath ?? null,
      fields.implementationSessionId ?? null,
      fields.error ?? null,
      fields.status,
      Date.now(),
      id,
    )
  }

  claimDispatchTarget(id: string, projectRoot: string, targetKey: string): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO dispatch_target_claims(project_root, target_key, dispatch_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(canonical(projectRoot), targetKey, id, Date.now())
    if (result.changes === 1) return true
    const existing = this.database.prepare(`
      SELECT dispatch_id FROM dispatch_target_claims WHERE project_root = ? AND target_key = ?
    `).get(canonical(projectRoot), targetKey)
    return String(existing?.dispatch_id ?? "") === id
  }

  releaseDispatchTargets(projectRoot: string, branch: string): void {
    const ids = this.database.prepare(`
      SELECT dispatch_id FROM dispatches WHERE project_root = ? AND branch = ?
    `).all(canonical(projectRoot), branch)
    for (const row of ids) {
      this.database.prepare("DELETE FROM dispatch_target_claims WHERE dispatch_id = ?").run(String(row.dispatch_id))
    }
  }

  registerManagedTarget(input: {
    repoRoot: string
    branch: string
    checkoutPath: string
    createdOid: string
    remote?: string
    remoteUrl?: string
    remoteBranch?: string
    ownsLocal: boolean
    ownsRemote?: boolean
  }): void {
    this.database.prepare(`
      INSERT INTO managed_targets(
        repo_root, branch, checkout_path, created_oid, remote, remote_url, remote_branch, owns_local, owns_remote, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_root, branch) DO UPDATE SET
        checkout_path = excluded.checkout_path,
        created_oid = excluded.created_oid,
        remote = COALESCE(managed_targets.remote, excluded.remote),
        remote_url = COALESCE(managed_targets.remote_url, excluded.remote_url),
        remote_branch = COALESCE(managed_targets.remote_branch, excluded.remote_branch),
        owns_local = MAX(managed_targets.owns_local, excluded.owns_local),
        owns_remote = MAX(managed_targets.owns_remote, excluded.owns_remote)
    `).run(
      canonical(input.repoRoot), input.branch, canonical(input.checkoutPath), input.createdOid,
      input.remote ?? null, input.remoteUrl ?? null, input.remoteBranch ?? null,
      input.ownsLocal ? 1 : 0, input.ownsRemote ? 1 : 0, Date.now(),
    )
  }

  managedTarget(repoRoot: string, branch: string): Record<string, unknown> | null {
    return this.database.prepare("SELECT * FROM managed_targets WHERE repo_root = ? AND branch = ?")
      .get(canonical(repoRoot), branch) ?? null
  }

  managedTargets(): Record<string, unknown>[] {
    return this.database.prepare("SELECT * FROM managed_targets ORDER BY repo_root, branch").all()
  }

  deleteManagedTarget(repoRoot: string, branch: string): void {
    this.database.prepare("DELETE FROM managed_targets WHERE repo_root = ? AND branch = ?")
      .run(canonical(repoRoot), branch)
  }

  saveCleanupJob(job: CleanupJob): void {
    this.database.prepare(`
      INSERT INTO cleanup_jobs(
        id, repo_root, checkout_path, branch, label, source, event_key, phase, delete_remote, delete_local,
        remote, remote_url, remote_branch, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET phase = excluded.phase, delete_remote = excluded.delete_remote,
        delete_local = excluded.delete_local,
        remote = excluded.remote, remote_url = excluded.remote_url, remote_branch = excluded.remote_branch, error = excluded.error,
        updated_at = excluded.updated_at
    `).run(
      job.id, canonical(job.repoRoot), canonical(job.checkoutPath), job.branch, job.label, job.source,
      job.eventKey, job.phase, job.deleteRemote ? 1 : 0, job.deleteLocal ? 1 : 0,
      job.remote, job.remoteUrl, job.remoteBranch, job.error,
      Date.now(), Date.now(),
    )
  }

  cleanupJobs(): CleanupJob[] {
    return this.database.prepare("SELECT * FROM cleanup_jobs ORDER BY created_at").all().map((row) => ({
      id: String(row.id),
      repoRoot: String(row.repo_root),
      checkoutPath: String(row.checkout_path),
      branch: String(row.branch),
      label: String(row.label),
      source: String(row.source),
      eventKey: row.event_key === null ? null : String(row.event_key),
      phase: String(row.phase) as CleanupPhase,
      deleteRemote: Number(row.delete_remote) === 1,
      deleteLocal: Number(row.delete_local) === 1,
      remote: row.remote === null ? null : String(row.remote),
      remoteUrl: row.remote_url === null ? null : String(row.remote_url),
      remoteBranch: row.remote_branch === null ? null : String(row.remote_branch),
      error: row.error === null ? null : String(row.error),
    }))
  }

  deleteCleanupJob(id: string): void {
    this.database.prepare("DELETE FROM cleanup_jobs WHERE id = ?").run(id)
  }

  markEventComplete(eventKey: string): void {
    if (!eventKey) return
    this.database.prepare("INSERT OR REPLACE INTO event_completions(event_key, completed_at) VALUES (?, ?)")
      .run(eventKey, Date.now())
  }

  eventCompleted(eventKey: string, withinMs = 60_000): boolean {
    if (!eventKey) return false
    const row = this.database.prepare("SELECT completed_at FROM event_completions WHERE event_key = ?").get(eventKey)
    return row !== undefined && Date.now() - Number(row.completed_at) <= withinMs
  }

  log(level: "info" | "error", kind: string, message: string): void {
    this.transaction(() => {
      this.database.prepare("INSERT INTO logs(created_at, level, kind, message) VALUES (?, ?, ?, ?)")
        .run(Date.now(), level, kind, message.slice(0, 8_000))
      this.database.exec("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 1000)")
    })
  }

  recentLogs(limit = 100): Array<{ createdAt: number; level: string; kind: string; message: string }> {
    return this.database.prepare("SELECT created_at, level, kind, message FROM logs ORDER BY id DESC LIMIT ?")
      .all(limit)
      .map((row) => ({
        createdAt: Number(row.created_at),
        level: String(row.level),
        kind: String(row.kind),
        message: String(row.message),
      }))
  }

  acquireLock(key: string, owner: string, staleAfterMs = 600_000): boolean {
    return this.transaction(() => {
      this.database.prepare("DELETE FROM locks WHERE key = ? AND acquired_at < ?").run(key, Date.now() - staleAfterMs)
      return this.database.prepare("INSERT OR IGNORE INTO locks(key, owner, acquired_at) VALUES (?, ?, ?)")
        .run(key, owner, Date.now()).changes === 1
    })
  }

  refreshLock(key: string, owner: string): boolean {
    return this.database.prepare("UPDATE locks SET acquired_at = ? WHERE key = ? AND owner = ?")
      .run(Date.now(), key, owner).changes === 1
  }

  releaseLock(key: string, owner: string): void {
    this.database.prepare("DELETE FROM locks WHERE key = ? AND owner = ?").run(key, owner)
  }

  blockAutoPrune(input: {
    key: string
    repoRoot: string
    checkoutPath: string
    branch: string
    headOid: string
    reasons: string[]
  }): boolean {
    return this.database.prepare(`
      INSERT OR IGNORE INTO auto_prune_blocks(key, repo_root, checkout_path, branch, head_oid, reasons, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.key, canonical(input.repoRoot), canonical(input.checkoutPath), input.branch,
      input.headOid, JSON.stringify(input.reasons), Date.now(),
    ).changes === 1
  }

  clearAutoPruneBlock(key: string): void {
    this.database.prepare("DELETE FROM auto_prune_blocks WHERE key = ?").run(key)
  }

}
