import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { canonical, stateDirectory } from "./paths.js"

export type CleanupPhase = "validate" | "remote" | "checkout" | "branch" | "prune"
export type DispatchStatus = "preparing" | "delivered" | "delivery_unknown"
export type TargetKind = "new" | "branch" | "pr"

export interface ChatContext {
  sessionId: string
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
  source_session_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  request TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_value TEXT NOT NULL,
  branch TEXT,
  checkout_path TEXT,
  implementation_session_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(source_session_id, source_message_id)
);
CREATE TABLE IF NOT EXISTS project_chats (
  session_id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
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
    ]) {
      const exists = this.database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
      if (!exists) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
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

  registerChat(context: ChatContext): void {
    this.database.prepare(`
      INSERT OR REPLACE INTO project_chats(
        session_id, project_root, pane_id, tab_id, workspace_id, herdr_bin, socket_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.sessionId,
      canonical(context.projectRoot),
      context.paneId,
      context.tabId,
      context.workspaceId,
      context.herdrBin,
      context.socketPath,
      Date.now(),
    )
  }

  chat(sessionId: string): ChatContext | null {
    const row = this.database.prepare("SELECT * FROM project_chats WHERE session_id = ?").get(sessionId)
    if (!row) return null
    return {
      sessionId: String(row.session_id),
      projectRoot: String(row.project_root),
      paneId: String(row.pane_id),
      tabId: String(row.tab_id),
      workspaceId: String(row.workspace_id),
      herdrBin: String(row.herdr_bin),
      socketPath: row.socket_path === null ? null : String(row.socket_path),
    }
  }

  beginDispatch(input: {
    sourceSessionId: string
    sourceMessageId: string
    projectRoot: string
    request: string
    targetKind: TargetKind
    targetValue: string
  }): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO dispatches(
        source_session_id, source_message_id, project_root, request, target_kind, target_value,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, ?)
    `).run(
      input.sourceSessionId,
      input.sourceMessageId,
      canonical(input.projectRoot),
      input.request,
      input.targetKind,
      input.targetValue,
      Date.now(),
      Date.now(),
    )
    return result.changes === 1
  }

  updateDispatch(sourceSessionId: string, sourceMessageId: string, fields: {
    status: DispatchStatus
    branch?: string
    checkoutPath?: string
    implementationSessionId?: string
    error?: string
  }): void {
    this.database.prepare(`
      UPDATE dispatches SET status = ?, branch = COALESCE(?, branch), checkout_path = COALESCE(?, checkout_path),
        implementation_session_id = COALESCE(?, implementation_session_id), error = ?, updated_at = ?
      WHERE source_session_id = ? AND source_message_id = ?
    `).run(
      fields.status,
      fields.branch ?? null,
      fields.checkoutPath ?? null,
      fields.implementationSessionId ?? null,
      fields.error ?? null,
      Date.now(),
      sourceSessionId,
      sourceMessageId,
    )
  }

  deleteDispatch(sourceSessionId: string, sourceMessageId: string): void {
    this.database.prepare("DELETE FROM dispatches WHERE source_session_id = ? AND source_message_id = ?")
      .run(sourceSessionId, sourceMessageId)
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
