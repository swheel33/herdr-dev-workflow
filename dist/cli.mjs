#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/auto-prune.ts
import { existsSync as existsSync3 } from "node:fs";
import { createHash as createHash2, randomUUID } from "node:crypto";

// src/git.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync2 } from "node:fs";
import { basename, dirname, resolve as resolve3 } from "node:path";

// src/errors.ts
var WorkflowError = class extends Error {
  constructor(message, cause) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.cause = cause;
    this.name = "WorkflowError";
  }
  cause;
};
var CommandError = class extends WorkflowError {
  constructor(command, exitCode, stdout, stderr, message = `Command failed: ${command.join(" ")}`) {
    super(message);
    this.command = command;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.name = "CommandError";
  }
  command;
  exitCode;
  stdout;
  stderr;
};

// src/paths.ts
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
function canonical(path) {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}
function stateDirectory(env = process.env) {
  return canonical(env.HERDR_PLUGIN_STATE_DIR ?? resolve(homedir(), ".local/state/herdr-dev-workflow"));
}
function pluginRoot(env = process.env) {
  const configured = env.HERDR_PLUGIN_ROOT;
  if (!configured || !isAbsolute(configured)) {
    throw new Error("HERDR_PLUGIN_ROOT must be an absolute path");
  }
  return canonical(configured);
}

// src/process.ts
var process_exports = {};
__export(process_exports, {
  executable: () => executable,
  run: () => run,
  runAsync: () => runAsync,
  shellQuote: () => shellQuote
});
import { spawn, spawnSync } from "node:child_process";
import { constants, existsSync, accessSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { delimiter, isAbsolute as isAbsolute2, resolve as resolve2 } from "node:path";
function run(command, options = {}) {
  const [executable2, ...args] = command;
  if (!executable2) throw new Error("Command must not be empty");
  const result = spawnSync(executable2, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    stdio: [options.input === void 0 ? "ignore" : "pipe", "pipe", "pipe"]
  });
  if (result.error) {
    throw new CommandError(command, null, result.stdout ?? "", result.stderr ?? "", `${executable2}: ${result.error.message}`);
  }
  const output = {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
  if (options.check !== false && output.exitCode !== 0) {
    throw new CommandError(command, output.exitCode, output.stdout, output.stderr);
  }
  return output;
}
async function runAsync(command, options = {}) {
  const [executable2, ...args] = command;
  if (!executable2) throw new Error("Command must not be empty");
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable2, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === void 0 ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (value) => {
      stdout += value;
    });
    child.stderr?.setEncoding("utf8").on("data", (value) => {
      stderr += value;
    });
    child.on("error", (error) => reject(new CommandError(command, null, stdout, stderr, `${executable2}: ${error.message}`)));
    child.on("close", (exitCode) => {
      const result = { exitCode: exitCode ?? 1, stdout, stderr };
      if (options.check !== false && result.exitCode !== 0) {
        reject(new CommandError(command, result.exitCode, stdout, stderr));
      } else {
        resolvePromise(result);
      }
    });
    if (options.input !== void 0) child.stdin?.end(options.input);
  });
}
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function executable(name, env = process.env) {
  const override = env[`${name.toUpperCase()}_BIN`];
  const candidates = [
    override,
    isAbsolute2(name) ? name : void 0,
    ...!isAbsolute2(name) ? (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => resolve2(directory, name)) : [],
    resolve2(homedir2(), "Library/pnpm", name),
    resolve2(homedir2(), ".local/bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`
  ].filter((value) => Boolean(value));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
    }
  }
  throw new Error(`Executable not found: ${name}`);
}

// src/git.ts
function git(repo, ...args) {
  return run(["git", "-C", repo, ...args]).stdout.trim();
}
function tryGit(repo, ...args) {
  const result = run(["git", "-C", repo, ...args], { check: false });
  return { ok: result.exitCode === 0, ...result };
}
function primaryRepository(path) {
  const common = tryGit(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common.ok || !common.stdout.trim()) return null;
  const bare = tryGit(path, "rev-parse", "--is-bare-repository");
  return canonical(bare.ok && bare.stdout.trim() === "true" ? common.stdout.trim() : dirname(common.stdout.trim()));
}
function worktrees(repo) {
  const output = git(repo, "worktree", "list", "--porcelain");
  const records = [];
  let current;
  for (const line of `${output}

`.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: canonical(line.slice(9)), locked: false, bare: false };
    } else if (!line && current) {
      records.push(current);
      current = void 0;
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice(18);
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true;
    } else if (current && line === "bare") {
      current.bare = true;
    }
  }
  return records;
}
function primaryWorktree(repo) {
  return worktrees(repo)[0] ?? null;
}
function worktreeForBranch(repo, branch) {
  return worktrees(repo).find((record) => record.branch === branch) ?? null;
}
function worktreeForPath(repo, path) {
  const expected = canonical(path);
  return worktrees(repo).find((record) => canonical(record.path) === expected) ?? null;
}
function hasOrigin(repo) {
  return tryGit(repo, "remote", "get-url", "origin").ok;
}
function remoteUrl(repo, remote = "origin") {
  return git(repo, "remote", "get-url", remote);
}
function fetchOrigin(repo) {
  if (hasOrigin(repo)) git(repo, "fetch", "origin", "--prune");
}
function localBranchExists(repo, branch) {
  return tryGit(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).ok;
}
function remoteBranchExists(repo, branch) {
  return tryGit(repo, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`).ok;
}
function defaultBranch(repo) {
  const symbolic = tryGit(repo, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
  if (symbolic.ok) return symbolic.stdout.trim().replace(/^refs\/remotes\/origin\//, "");
  for (const candidate of ["main", "master", "develop"]) {
    if (localBranchExists(repo, candidate)) return candidate;
  }
  const primary = primaryWorktree(repo);
  if (primary?.branch) return primary.branch;
  const current = tryGit(repo, "branch", "--show-current").stdout.trim();
  if (current) return current;
  throw new WorkflowError(`Could not determine the default branch for ${repo}`);
}
function defaultBaseRef(repo) {
  const branch = defaultBranch(repo);
  return remoteBranchExists(repo, branch) ? `origin/${branch}` : branch;
}
function protectedBranches(repo, env = process.env) {
  const protectedSet = /* @__PURE__ */ new Set(["main", "master", defaultBranch(repo)]);
  for (const branch of (env.HERDR_PROTECTED_BRANCHES ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    protectedSet.add(branch);
  }
  return protectedSet;
}
function slugify(value) {
  const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
  if (!slug || slug === "." || slug === "..") throw new WorkflowError("Target name must contain a letter or number");
  return slug;
}
function safeWorktreeName(branch) {
  const slug = slugify(branch).slice(0, 48);
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}
function managedWorktreePath(repo, name) {
  return resolve3(repo, ".worktrees", name);
}
function createWorktree(repo, checkout, branch, base) {
  if (existsSync2(checkout)) throw new WorkflowError(`Worktree path already exists: ${checkout}`);
  git(repo, "worktree", "add", "-b", branch, checkout, base);
}
function createTrackingWorktree(repo, checkout, branch) {
  if (existsSync2(checkout)) throw new WorkflowError(`Worktree path already exists: ${checkout}`);
  if (localBranchExists(repo, branch)) {
    git(repo, "worktree", "add", checkout, branch);
    return { createdLocalBranch: false };
  } else if (remoteBranchExists(repo, branch)) {
    git(repo, "worktree", "add", "-b", branch, checkout, `origin/${branch}`);
    return { createdLocalBranch: true };
  } else {
    throw new WorkflowError(`Branch does not exist locally or on origin: ${branch}`);
  }
}
function removeWorktree(repo, checkout) {
  const record = worktreeForPath(repo, checkout);
  if (!record) {
    if (existsSync2(checkout)) throw new WorkflowError(`Path exists without matching Git worktree metadata: ${checkout}`);
    return;
  }
  if (record.locked) git(repo, "worktree", "unlock", checkout);
  git(repo, "worktree", "remove", "--force", checkout);
}
function deleteLocalBranch(repo, branch) {
  if (localBranchExists(repo, branch)) git(repo, "branch", "-D", branch);
}
function deleteRemoteBranch(repo, remote, branch, expectedRemoteUrl) {
  const currentRemoteUrl = remoteUrl(repo, remote);
  if (currentRemoteUrl !== expectedRemoteUrl) {
    throw new WorkflowError(`Remote ${remote} changed; expected ${expectedRemoteUrl}, found ${currentRemoteUrl}`);
  }
  const exists = run(["git", "-C", repo, "ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`], { check: false });
  if (exists.exitCode === 0) git(repo, "push", remote, "--delete", branch);
  else if (exists.exitCode !== 2) throw new CommandError(["git", "-C", repo, "ls-remote"], exists.exitCode, exists.stdout, exists.stderr);
}
function branchHead(repo, branch) {
  return git(repo, "rev-parse", `refs/heads/${branch}`);
}
function checkoutDirty(checkout) {
  return Boolean(git(checkout, "status", "--porcelain", "--untracked-files=all"));
}
function synchronizeDefaultBranch(repo) {
  if (!hasOrigin(repo)) return "no_remote";
  fetchOrigin(repo);
  const branch = defaultBranch(repo);
  const localRef = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/origin/${branch}`;
  if (!localBranchExists(repo, branch) || !remoteBranchExists(repo, branch)) return "current";
  const primary = primaryWorktree(repo);
  if (!primary || primary.branch !== branch) return "not_primary";
  const localOid = git(repo, "rev-parse", localRef);
  const remoteOid = git(repo, "rev-parse", remoteRef);
  if (localOid === remoteOid) return "current";
  if (checkoutDirty(primary.path)) return "dirty";
  const localAncestor = tryGit(repo, "merge-base", "--is-ancestor", localRef, remoteRef);
  if (localAncestor.ok) {
    git(primary.path, "merge", "--ff-only", remoteRef);
    return "updated";
  }
  return tryGit(repo, "merge-base", "--is-ancestor", remoteRef, localRef).ok ? "ahead" : "diverged";
}

// src/opencode.ts
import { readFileSync } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { resolve as resolve4 } from "node:path";
function servicePath(env = process.env) {
  return resolve4(env.XDG_STATE_HOME ?? resolve4(homedir3(), ".local/state"), "opencode/service.json");
}
function readService(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(servicePath(env), "utf8"));
    return parsed.url ? parsed : null;
  } catch {
    return null;
  }
}
function cliIdentity(env = process.env) {
  const binary = executable("opencode2", env);
  const result = run([binary, "--version"], { check: false, env });
  const version = result.stdout.match(/0\.0\.0-next-\d+/)?.[0];
  if (result.exitCode !== 0 || !version) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new WorkflowError(`OpenCode 2 CLI is not executable: ${detail}`);
  }
  return { binary, version };
}
async function healthy(info) {
  try {
    await requestWithService(info, "GET", "/api/health", void 0, 5e3);
    return true;
  } catch {
    return false;
  }
}
async function service(env = process.env) {
  const cli = cliIdentity(env);
  let info = readService(env);
  if (info?.version === cli.version && await healthy(info)) return info;
  run([cli.binary, "service", info ? "restart" : "start"], { env });
  const deadline = Date.now() + 3e4;
  while (Date.now() < deadline) {
    info = readService(env);
    if (info?.version === cli.version && await healthy(info)) return info;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const actual = info?.version ?? "missing";
  throw new WorkflowError(`OpenCode 2 service did not become healthy on CLI version ${cli.version} (service: ${actual})`);
}
function openCodeCli(env = process.env) {
  return cliIdentity(env).binary;
}
function openCodeVersion(env = process.env) {
  return cliIdentity(env).version;
}
async function ensureOpenCodeReady(env = process.env) {
  const cli = cliIdentity(env);
  const help = run([cli.binary, "--help"], { check: false, env });
  if (help.exitCode !== 0 || !help.stdout.includes("--session") || !help.stdout.includes("--standalone")) {
    throw new WorkflowError("OpenCode 2 full TUI does not expose the required --session and --standalone options");
  }
  await service(env);
}
async function requestWithService(info, method, path, body, timeout = 3e4) {
  const headers = { "content-type": "application/json" };
  if (info.password) headers.authorization = `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`;
  const response = await fetch(new URL(path, info.url), {
    method,
    headers,
    ...body === void 0 ? {} : { body: JSON.stringify(body) },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new WorkflowError(`OpenCode API ${method} ${path} failed (${response.status}): ${await response.text()}`);
  if (response.status === 204) return void 0;
  return await response.json();
}
async function request(method, path, body, env = process.env) {
  return await requestWithService(await service(env), method, path, body);
}
async function forkSession(sourceSessionId, sourceMessageId) {
  const response = await request("POST", `/api/session/${encodeURIComponent(sourceSessionId)}/fork`, {
    boundary: { type: "before", messageID: sourceMessageId }
  });
  return response.data;
}
async function getSession(sessionId, env = process.env) {
  const response = await request("GET", `/api/session/${encodeURIComponent(sessionId)}`, void 0, env);
  return response.data;
}
async function renameSession(sessionId, title) {
  await request("POST", `/api/session/${encodeURIComponent(sessionId)}/rename`, { title });
}
async function prepareImplementationSession(sessionId, directory) {
  await request("POST", `/api/session/${encodeURIComponent(sessionId)}/move`, { directory });
  await request("POST", `/api/session/${encodeURIComponent(sessionId)}/agent`, { agent: "build" });
}
async function promptSession(sessionId, text, onAttempt) {
  const info = await service();
  onAttempt?.();
  await requestWithService(info, "POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text });
}

// src/herdr.ts
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowError("Herdr returned invalid JSON");
  return value;
}
var HerdrClient = class {
  constructor(binary = process.env.HERDR_BIN_PATH ?? "herdr", socketPath = process.env.HERDR_SOCKET_PATH) {
    this.binary = binary;
    this.socketPath = socketPath;
  }
  binary;
  socketPath;
  env() {
    return this.socketPath ? { ...process.env, HERDR_SOCKET_PATH: this.socketPath } : process.env;
  }
  command(args, check = true) {
    return run([this.binary, ...args], { check, env: this.env() });
  }
  json(args) {
    const parsed = JSON.parse(this.command(args).stdout);
    const envelope = object(parsed);
    if (envelope.error) throw new WorkflowError(JSON.stringify(envelope.error));
    return object(envelope.result ?? envelope);
  }
  notify(title, body) {
    this.command(["notification", "show", title.slice(0, 80), "--body", body.slice(0, 240), "--sound", "none"], false);
  }
  workspaces() {
    const result = this.json(["workspace", "list"]);
    return Array.isArray(result.workspaces) ? result.workspaces.map(object) : [];
  }
  panes(workspaceId) {
    const args = ["pane", "list", ...workspaceId ? ["--workspace", workspaceId] : []];
    const result = this.json(args);
    return Array.isArray(result.panes) ? result.panes.map(object) : [];
  }
  tabs() {
    const result = this.json(["tab", "list"]);
    return Array.isArray(result.tabs) ? result.tabs.map(object) : [];
  }
  runningSessionCount() {
    const result = this.json(["session", "list", "--json"]);
    const sessions = Array.isArray(result.sessions) ? result.sessions.map(object) : [];
    return sessions.filter((session) => session.running === true).length;
  }
  focusWorkspace(workspaceId) {
    this.command(["workspace", "focus", workspaceId]);
  }
  openWorktree(repo, checkout, label) {
    const result = this.json([
      "worktree",
      "open",
      "--cwd",
      repo,
      "--path",
      checkout,
      "--label",
      label,
      "--no-focus",
      "--json"
    ]);
    const workspace = object(result.workspace);
    const rootPane = result.root_pane ? object(result.root_pane) : null;
    const workspaceId = String(workspace.workspace_id ?? "");
    const existingPanes = workspaceId ? this.panes(workspaceId) : [];
    const rootPaneId = String(rootPane?.pane_id ?? existingPanes[0]?.pane_id ?? "");
    if (!workspaceId || !rootPaneId) throw new WorkflowError("Herdr did not return workspace and root pane identities");
    return { workspaceId, rootPaneId, alreadyOpen: result.already_open === true };
  }
  splitPane(rootPaneId, checkout) {
    const result = this.json(["pane", "split", rootPaneId, "--direction", "down", "--ratio", "0.70", "--cwd", checkout, "--no-focus"]);
    const pane = result.pane ? object(result.pane) : result;
    const id = String(pane.pane_id ?? "");
    if (!id) throw new WorkflowError("Herdr did not return the shell pane identity");
    return id;
  }
  runInPane(paneId, command) {
    this.command(["pane", "run", paneId, command]);
  }
  launchOpenCode(paneId, checkout, sessionId) {
    this.runInPane(paneId, `exec ${shellQuote(openCodeCli())} ${shellQuote(checkout)} --session ${shellQuote(sessionId)}`);
  }
  runInstall(paneId, checkout) {
    this.runInPane(paneId, `cd -- ${shellQuote(checkout)} && pnpm install`);
  }
  closeWorkspace(workspaceId) {
    this.command(["workspace", "close", workspaceId]);
    if (this.workspaces().some((workspace) => workspace.workspace_id === workspaceId)) {
      throw new WorkflowError(`Herdr workspace did not close: ${workspaceId}`);
    }
  }
  closeTab(tabId) {
    this.command(["tab", "close", tabId]);
  }
  openPluginPane(entrypoint, options) {
    const args = [
      "plugin",
      "pane",
      "open",
      "--plugin",
      process.env.HERDR_PLUGIN_ID ?? "wheels.dev-workflow",
      "--entrypoint",
      entrypoint,
      "--cwd",
      options.cwd
    ];
    if (options.workspaceId && !options.targetPane) args.push("--workspace", options.workspaceId);
    if (options.placement) args.push("--placement", options.placement);
    if (options.targetPane) args.push("--target-pane", options.targetPane);
    if (options.direction) args.push("--direction", options.direction);
    for (const [key, value] of Object.entries(options.env ?? {})) args.push("--env", `${key}=${value}`);
    args.push(options.focus === false ? "--no-focus" : "--focus");
    return this.json(args);
  }
};
function pluginContext(env = process.env) {
  try {
    return object(JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}"));
  } catch {
    return {};
  }
}
function currentHerdrIdentity(env = process.env) {
  const context = pluginContext(env);
  const paneId = env.HERDR_PANE_ID ?? String(context.pane_id ?? "");
  const tabId = env.HERDR_TAB_ID ?? String(context.tab_id ?? "");
  const workspaceId = env.HERDR_WORKSPACE_ID ?? String(context.workspace_id ?? "");
  if (!paneId || !tabId || !workspaceId) throw new WorkflowError("Herdr pane, tab, or workspace identity is missing");
  return { paneId, tabId, workspaceId };
}

// src/state.ts
import { mkdirSync } from "node:fs";
import { dirname as dirname2, resolve as resolve5 } from "node:path";
import { DatabaseSync } from "node:sqlite";
var SCHEMA = `
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
`;
var StateStore = class {
  database;
  constructor(path = resolve5(stateDirectory(), "workflow.sqlite")) {
    mkdirSync(dirname2(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(SCHEMA);
    for (const [table, column, definition] of [
      ["managed_targets", "remote_url", "TEXT"],
      ["managed_targets", "owns_local", "INTEGER NOT NULL DEFAULT 1"],
      ["cleanup_jobs", "remote_url", "TEXT"],
      ["cleanup_jobs", "delete_local", "INTEGER NOT NULL DEFAULT 0"]
    ]) {
      const exists = this.database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
      if (!exists) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  close() {
    this.database.close();
  }
  transaction(operation) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  rememberRepository(root) {
    this.database.prepare(`
      INSERT INTO repositories(root, updated_at) VALUES (?, ?)
      ON CONFLICT(root) DO UPDATE SET updated_at = excluded.updated_at
    `).run(canonical(root), Date.now());
  }
  repositories() {
    return this.database.prepare("SELECT root FROM repositories ORDER BY root").all().map((row) => String(row.root));
  }
  registerHub(context) {
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
      Date.now()
    );
  }
  hub(projectRoot) {
    const row = this.database.prepare("SELECT * FROM project_hubs WHERE project_root = ?").get(canonical(projectRoot));
    if (!row) return null;
    return {
      projectRoot: String(row.project_root),
      paneId: String(row.pane_id),
      tabId: String(row.tab_id),
      workspaceId: String(row.workspace_id),
      herdrBin: String(row.herdr_bin),
      socketPath: row.socket_path === null ? null : String(row.socket_path)
    };
  }
  async waitForHub(projectRoot, previousPaneId, timeout = 1e4) {
    const deadline = Date.now() + timeout;
    do {
      const hub = this.hub(projectRoot);
      if (hub && hub.paneId !== previousPaneId) return hub;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    } while (Date.now() < deadline);
    throw new Error(`Project Chat hub did not start for ${canonical(projectRoot)}`);
  }
  deleteHub(projectRoot, paneId) {
    const query = paneId ? "DELETE FROM project_hubs WHERE project_root = ? AND pane_id = ?" : "DELETE FROM project_hubs WHERE project_root = ?";
    this.database.prepare(query).run(...paneId ? [canonical(projectRoot), paneId] : [canonical(projectRoot)]);
  }
  beginDispatch(input) {
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
      Date.now()
    );
    return result.changes === 1;
  }
  updateDispatch(sourceSessionId, sourceMessageId, fields) {
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
      sourceMessageId
    );
  }
  deleteDispatch(sourceSessionId, sourceMessageId) {
    this.database.prepare("DELETE FROM dispatches WHERE source_session_id = ? AND source_message_id = ?").run(sourceSessionId, sourceMessageId);
  }
  registerManagedTarget(input) {
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
      canonical(input.repoRoot),
      input.branch,
      canonical(input.checkoutPath),
      input.createdOid,
      input.remote ?? null,
      input.remoteUrl ?? null,
      input.remoteBranch ?? null,
      input.ownsLocal ? 1 : 0,
      input.ownsRemote ? 1 : 0,
      Date.now()
    );
  }
  managedTarget(repoRoot, branch) {
    return this.database.prepare("SELECT * FROM managed_targets WHERE repo_root = ? AND branch = ?").get(canonical(repoRoot), branch) ?? null;
  }
  managedTargets() {
    return this.database.prepare("SELECT * FROM managed_targets ORDER BY repo_root, branch").all();
  }
  deleteManagedTarget(repoRoot, branch) {
    this.database.prepare("DELETE FROM managed_targets WHERE repo_root = ? AND branch = ?").run(canonical(repoRoot), branch);
  }
  saveCleanupJob(job) {
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
      job.id,
      canonical(job.repoRoot),
      canonical(job.checkoutPath),
      job.branch,
      job.label,
      job.source,
      job.eventKey,
      job.phase,
      job.deleteRemote ? 1 : 0,
      job.deleteLocal ? 1 : 0,
      job.remote,
      job.remoteUrl,
      job.remoteBranch,
      job.error,
      Date.now(),
      Date.now()
    );
  }
  cleanupJobs() {
    return this.database.prepare("SELECT * FROM cleanup_jobs ORDER BY created_at").all().map((row) => ({
      id: String(row.id),
      repoRoot: String(row.repo_root),
      checkoutPath: String(row.checkout_path),
      branch: String(row.branch),
      label: String(row.label),
      source: String(row.source),
      eventKey: row.event_key === null ? null : String(row.event_key),
      phase: String(row.phase),
      deleteRemote: Number(row.delete_remote) === 1,
      deleteLocal: Number(row.delete_local) === 1,
      remote: row.remote === null ? null : String(row.remote),
      remoteUrl: row.remote_url === null ? null : String(row.remote_url),
      remoteBranch: row.remote_branch === null ? null : String(row.remote_branch),
      error: row.error === null ? null : String(row.error)
    }));
  }
  deleteCleanupJob(id) {
    this.database.prepare("DELETE FROM cleanup_jobs WHERE id = ?").run(id);
  }
  markEventComplete(eventKey) {
    if (!eventKey) return;
    this.database.prepare("INSERT OR REPLACE INTO event_completions(event_key, completed_at) VALUES (?, ?)").run(eventKey, Date.now());
  }
  eventCompleted(eventKey, withinMs = 6e4) {
    if (!eventKey) return false;
    const row = this.database.prepare("SELECT completed_at FROM event_completions WHERE event_key = ?").get(eventKey);
    return row !== void 0 && Date.now() - Number(row.completed_at) <= withinMs;
  }
  log(level, kind, message) {
    this.transaction(() => {
      this.database.prepare("INSERT INTO logs(created_at, level, kind, message) VALUES (?, ?, ?, ?)").run(Date.now(), level, kind, message.slice(0, 8e3));
      this.database.exec("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 1000)");
    });
  }
  recentLogs(limit = 100) {
    return this.database.prepare("SELECT created_at, level, kind, message FROM logs ORDER BY id DESC LIMIT ?").all(limit).map((row) => ({
      createdAt: Number(row.created_at),
      level: String(row.level),
      kind: String(row.kind),
      message: String(row.message)
    }));
  }
  acquireLock(key, owner, staleAfterMs = 6e5) {
    return this.transaction(() => {
      this.database.prepare("DELETE FROM locks WHERE key = ? AND acquired_at < ?").run(key, Date.now() - staleAfterMs);
      return this.database.prepare("INSERT OR IGNORE INTO locks(key, owner, acquired_at) VALUES (?, ?, ?)").run(key, owner, Date.now()).changes === 1;
    });
  }
  refreshLock(key, owner) {
    return this.database.prepare("UPDATE locks SET acquired_at = ? WHERE key = ? AND owner = ?").run(Date.now(), key, owner).changes === 1;
  }
  releaseLock(key, owner) {
    this.database.prepare("DELETE FROM locks WHERE key = ? AND owner = ?").run(key, owner);
  }
  blockAutoPrune(input) {
    return this.database.prepare(`
      INSERT OR IGNORE INTO auto_prune_blocks(key, repo_root, checkout_path, branch, head_oid, reasons, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.key,
      canonical(input.repoRoot),
      canonical(input.checkoutPath),
      input.branch,
      input.headOid,
      JSON.stringify(input.reasons),
      Date.now()
    ).changes === 1;
  }
  clearAutoPruneBlock(key) {
    this.database.prepare("DELETE FROM auto_prune_blocks WHERE key = ?").run(key);
  }
};

// src/auto-prune.ts
function exactMergedPullRequest(repo, branch, head) {
  const result = run([
    "gh",
    "pr",
    "list",
    "--state",
    "merged",
    "--head",
    branch,
    "--limit",
    "20",
    "--json",
    "mergedAt,headRefName,headRefOid,isCrossRepository"
  ], { cwd: repo, check: false });
  if (result.exitCode) return false;
  const prs = JSON.parse(result.stdout);
  return prs.some((pr) => pr.mergedAt && pr.headRefName === branch && pr.headRefOid === head && pr.isCrossRepository === false);
}
function scanMerged(store = new StateStore(), herdr = new HerdrClient()) {
  let checked = 0;
  let closed = 0;
  let blocked = 0;
  const openWorkspaces = herdr.workspaces();
  const singleSession = herdr.runningSessionCount() === 1;
  for (const target of store.managedTargets()) {
    const repo = String(target.repo_root);
    const checkout = canonical(String(target.checkout_path));
    const branch = String(target.branch);
    try {
      fetchOrigin(repo);
      const baseBranch = defaultBranch(repo);
      const base = remoteBranchExists(repo, baseBranch) ? `origin/${baseBranch}` : baseBranch;
      const tree = worktreeForPath(repo, checkout);
      if (!tree?.head || tree.branch !== branch) continue;
      checked += 1;
      const integrated = tree.head !== String(target.created_oid) && tryGit(repo, "merge-base", "--is-ancestor", tree.head, base).ok;
      const mergedPullRequest = !integrated && exactMergedPullRequest(repo, branch, tree.head);
      if (!integrated && !mergedPullRequest) continue;
      const workspace = openWorkspaces.find((item) => {
        const provenance = item.worktree;
        return provenance?.checkout_path && canonical(String(provenance.checkout_path)) === checkout;
      });
      const reasons = [];
      if (!singleSession) reasons.push("multiple Herdr sessions are running");
      if (!workspace) reasons.push("worktree is not open in this Herdr session");
      else if (workspace.focused === true) reasons.push("workspace is focused");
      else if (!["idle", "done"].includes(String(workspace.agent_status ?? ""))) reasons.push(`agent is ${workspace.agent_status ?? "unknown"}`);
      if (checkoutDirty(checkout)) reasons.push("checkout has uncommitted changes");
      const blockKey = createHash2("sha256").update(`${canonical(repo)}\0${checkout}\0${branch}\0${tree.head}`).digest("hex").slice(0, 24);
      if (reasons.length) {
        blocked += 1;
        store.log("info", "auto-prune.blocked", JSON.stringify({ repo, checkout, branch, head: tree.head, reasons }));
        if (store.blockAutoPrune({ key: blockKey, repoRoot: repo, checkoutPath: checkout, branch, headOid: tree.head, reasons })) {
          herdr.notify("Merged worktree needs manual cleanup", `${branch}: ${reasons.join(", ")}.`);
        }
        continue;
      }
      store.clearAutoPruneBlock(blockKey);
      store.log("info", "auto-prune.closing", JSON.stringify({
        repo,
        checkout,
        branch,
        head: tree.head,
        mergedBy: integrated ? "default-branch" : "pull-request"
      }));
      try {
        herdr.closeWorkspace(String(workspace.workspace_id));
        closed += 1;
        store.log("info", "auto-prune.closed", JSON.stringify({ repo, checkout, branch, head: tree.head }));
      } catch (error) {
        store.log("error", "auto-prune.close-failed", JSON.stringify({ repo, checkout, branch, error: String(error) }));
      }
    } catch (error) {
      store.log("error", "auto-prune.scan-failed", JSON.stringify({ repo, checkout, branch, error: String(error) }));
      continue;
    }
  }
  const result = { checked, closed, blocked };
  store.log("info", "auto-prune.scan", JSON.stringify(result));
  return result;
}
async function watchMerged(store = new StateStore()) {
  const owner = randomUUID();
  const configured = Number(process.env.HERDR_AUTO_PRUNE_INTERVAL_SECONDS ?? 3600);
  const interval = Math.max(60, Number.isFinite(configured) ? configured : 3600) * 1e3;
  if (!store.acquireLock("auto-prune-watcher", owner, Math.max(interval * 2, 12e4))) return;
  try {
    while (!process.env.HERDR_SOCKET_PATH || existsSync3(process.env.HERDR_SOCKET_PATH)) {
      if (!store.refreshLock("auto-prune-watcher", owner)) return;
      try {
        scanMerged(store);
      } catch (error) {
        store.log("error", "auto-prune.watcher", String(error));
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, interval));
    }
  } finally {
    store.releaseLock("auto-prune-watcher", owner);
  }
}

// src/cli.ts
import { readSync as readSync2 } from "node:fs";

// src/chat.ts
import { existsSync as existsSync4, lstatSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { basename as basename2, join, resolve as resolve6 } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn as spawn2 } from "node:child_process";
function ensureCompanionInstalled(env = process.env) {
  const source = resolve6(pluginRoot(env), "dist/opencode-plugin.mjs");
  if (!existsSync4(source)) throw new WorkflowError(`OpenCode companion bundle is missing: ${source}`);
  const configHome = resolve6(env.XDG_CONFIG_HOME ?? join(homedir4(), ".config"), "opencode");
  const autoPluginDirectory = resolve6(configHome, "plugins");
  mkdirSync2(autoPluginDirectory, { recursive: true });
  const destination = resolve6(autoPluginDirectory, "wheels-dev-workflow.js");
  const obsoleteDestinations = [
    resolve6(autoPluginDirectory, "wheels-dev-workflow.mjs"),
    resolve6(configHome, "wheels-dev-workflow.js"),
    resolve6(autoPluginDirectory, "tui/wheels-dev-workflow.js")
  ];
  for (const path of obsoleteDestinations) {
    if (!lstatMaybe(path)) continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || readFileSync2(path, "utf8").startsWith("// Managed by Wheels Dev Workflow")) {
      unlinkSync(path);
    } else {
      throw new WorkflowError(`Refusing to replace unmanaged OpenCode plugin: ${path}`);
    }
  }
  if (lstatMaybe(destination)) {
    const stat = lstatSync(destination);
    if (stat.isSymbolicLink()) unlinkSync(destination);
    else if (!readFileSync2(destination, "utf8").startsWith("// Managed by Wheels Dev Workflow")) {
      throw new WorkflowError(`Refusing to replace unmanaged OpenCode plugin: ${destination}`);
    }
  }
  const herdrBin = executable(env.HERDR_BIN_PATH ?? "herdr", env);
  const sourceUrl = `${pathToFileURL(source).href}?mtime=${statSync(source).mtimeMs}`;
  const loader = `// Managed by Wheels Dev Workflow
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
const source = ${JSON.stringify(source)}
const sourceUrl = ${JSON.stringify(sourceUrl)}
const herdr = ${JSON.stringify(herdrBin)}
function enabled() {
  const result = spawnSync(herdr, ["plugin", "list", "--plugin", "wheels.dev-workflow", "--json"], { encoding: "utf8" })
  if (result.status !== 0) return false
  try {
    const response = JSON.parse(result.stdout)
    return response?.result?.plugins?.some((plugin) => plugin.plugin_id === "wheels.dev-workflow" && plugin.enabled === true) === true
  } catch {
    return false
  }
}
let plugin = { id: "wheels.dev-workflow.disabled", setup() {} }
if (existsSync(source) && enabled()) {
  const loaded = (await import(sourceUrl)).default
  plugin = {
    ...loaded,
    setup(ctx) {
      return loaded.setup({
        ...ctx,
        options: { ...ctx.options, pluginRoot: ${JSON.stringify(pluginRoot(env))}, stateDir: ${JSON.stringify(stateDirectory(env))} },
      })
    },
  }
}
export default plugin
`;
  if (!existsSync4(destination) || readFileSync2(destination, "utf8") !== loader) writeFileSync(destination, loader);
  return destination;
}
function lstatMaybe(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function currentProjectRoot(env = process.env) {
  const context = pluginContext(env);
  for (const candidate of [context.focused_pane_cwd, context.workspace_cwd, process.cwd()]) {
    if (typeof candidate !== "string") continue;
    const root = primaryRepository(candidate);
    if (root) return root;
  }
  return null;
}
function primaryWorkspace(root, herdr) {
  for (const workspace of herdr.workspaces()) {
    const provenance = workspace.worktree;
    if (provenance?.is_linked_worktree === false && provenance.checkout_path && canonical(String(provenance.checkout_path)) === root) {
      const tabId = String(workspace.active_tab_id ?? "");
      if (!tabId) throw new WorkflowError(`Primary workspace for ${root} has no active tab`);
      return { workspaceId: String(workspace.workspace_id), replaceTabId: tabId };
    }
  }
  const opened = herdr.openWorktree(root, root, basename2(root));
  if (opened.alreadyOpen) {
    const pane = herdr.panes(opened.workspaceId).find((candidate) => String(candidate.pane_id) === opened.rootPaneId);
    const tabId = String(pane?.tab_id ?? "");
    if (!tabId) throw new WorkflowError(`Primary workspace for ${root} has no root tab`);
    return { workspaceId: opened.workspaceId, replaceTabId: tabId };
  }
  return { workspaceId: opened.workspaceId, bootstrapPaneId: opened.rootPaneId };
}
async function openChat(root) {
  const canonicalRoot = canonical(root);
  const store = new StateStore();
  const hub = store.hub(canonicalRoot);
  if (hub) {
    const hubHerdr = new HerdrClient(hub.herdrBin, hub.socketPath ?? void 0);
    try {
      if (hubHerdr.tabs().some((tab) => String(tab.tab_id) === hub.tabId)) {
        hubHerdr.focusWorkspace(hub.workspaceId);
        store.close();
        return;
      }
    } catch {
    }
    store.deleteHub(canonicalRoot);
  }
  try {
    openCodeCli();
    await ensureOpenCodeReady();
    const herdr = new HerdrClient();
    const workspace = primaryWorkspace(canonicalRoot, herdr);
    herdr.openPluginPane("dispatcher-chat", {
      cwd: canonicalRoot,
      workspaceId: workspace.workspaceId,
      placement: workspace.bootstrapPaneId ? "split" : "tab",
      ...workspace.bootstrapPaneId ? { targetPane: workspace.bootstrapPaneId } : {},
      ...workspace.bootstrapPaneId ? { direction: "down" } : {},
      focus: true,
      env: { HERDR_PROJECT_ROOT: canonicalRoot }
    });
    await store.waitForHub(canonicalRoot);
    if (workspace.bootstrapPaneId) herdr.command(["pane", "close", workspace.bootstrapPaneId], false);
    if (workspace.replaceTabId) herdr.closeTab(workspace.replaceTabId);
  } finally {
    store.close();
  }
}
async function chatCurrent() {
  const root = currentProjectRoot();
  if (!root) {
    const context = pluginContext();
    const cwd = String(context.focused_pane_cwd ?? context.workspace_cwd ?? process.cwd());
    new HerdrClient().openPluginPane("dispatcher-picker", { cwd });
    return;
  }
  await openChat(root);
}
function discoverProjects(store = new StateStore(), projectsRoot = process.env.HERDR_PROJECTS_ROOT ?? resolve6(homedir4(), "Projects")) {
  const roots = new Set(store.repositories());
  const visit = (directory) => {
    if (!existsSync4(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || [".git", ".worktrees", "node_modules"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (existsSync4(join(path, ".git"))) {
        const root = primaryRepository(path);
        if (root) roots.add(root);
      } else {
        visit(path);
      }
    }
  };
  visit(projectsRoot);
  return [...roots].sort((a, b) => basename2(a).localeCompare(basename2(b)));
}
function fzf(rows, prompt2) {
  const result = run(["fzf", "--prompt", prompt2, "--height", "100%", "--reverse"], { input: rows, check: false });
  if ([1, 130].includes(result.exitCode)) return null;
  if (result.exitCode) throw new WorkflowError(result.stderr || "fzf failed");
  return result.stdout.trim();
}
async function openChatPicker() {
  const projects = discoverProjects();
  if (!projects.length) throw new WorkflowError("No Git repositories found");
  const selection = fzf(projects.map((root) => `${basename2(root)}	${root}`).join("\n"), "project> ");
  if (selection) await openChat(selection.split("	").at(-1));
}
async function runChatPane(env = process.env) {
  const root = canonical(env.HERDR_PROJECT_ROOT ?? "");
  if (primaryRepository(root) !== root) throw new WorkflowError(`Invalid Project Chat repository: ${root}`);
  const opencode = openCodeCli(env);
  ensureCompanionInstalled(env);
  await ensureOpenCodeReady(env);
  const identity = currentHerdrIdentity(env);
  const store = new StateStore();
  store.rememberRepository(root);
  store.registerHub({
    projectRoot: root,
    ...identity,
    herdrBin: env.HERDR_BIN_PATH ?? "herdr",
    socketPath: env.HERDR_SOCKET_PATH ?? null
  });
  const args = [root, "--standalone"];
  store.log("info", "project-chat.launch", JSON.stringify({ args, paneId: identity.paneId, tabId: identity.tabId }));
  const child = spawn2(opencode, args, { stdio: "inherit", env: { ...env, HERDR_PROJECT_CHAT: "1" } });
  let exitCode = null;
  let exitSignal = null;
  const exit = new Promise((resolvePromise, reject) => {
    child.once("error", (error) => reject(new WorkflowError(`Could not start opencode2: ${error.message}`)));
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolvePromise(code ?? 1);
    });
  });
  try {
    store.log("info", "project-chat.ready", JSON.stringify({ paneId: identity.paneId, tabId: identity.tabId }));
    const code = await exit;
    if (code !== 0) throw new WorkflowError(`opencode2 exited with status ${code}${exitSignal ? ` (${exitSignal})` : ""}`);
    return 0;
  } catch (error) {
    store.log("error", "project-chat.exit", JSON.stringify({ paneId: identity.paneId, exitCode, exitSignal, error: String(error) }));
    throw error;
  } finally {
    store.deleteHub(root, identity.paneId);
    store.close();
  }
}

// src/cleanup.ts
import { createHash as createHash3 } from "node:crypto";
import { randomUUID as randomUUID2 } from "node:crypto";
import { basename as basename3 } from "node:path";
function cleanupId(repo, checkout, branch) {
  return createHash3("sha256").update(`${canonical(repo)}\0${canonical(checkout)}\0${branch}`).digest("hex").slice(0, 24);
}
function errorRecord(error) {
  if (error instanceof CommandError) {
    return JSON.stringify({
      message: error.message,
      command: error.command,
      exitCode: error.exitCode,
      stdout: error.stdout,
      stderr: error.stderr
    });
  }
  return JSON.stringify({ message: error instanceof Error ? error.message : String(error) });
}
function enqueueCleanup(input) {
  const repoRoot = canonical(input.repoRoot);
  const checkoutPath = canonical(input.checkoutPath);
  const managed = input.store.managedTarget(repoRoot, input.branch);
  const targetMatches = managed !== null && String(managed.checkout_path) === checkoutPath;
  const ownsRemote = targetMatches && Number(managed.owns_remote) === 1 && Boolean(managed.remote_url);
  const job = {
    id: cleanupId(repoRoot, checkoutPath, input.branch),
    repoRoot,
    checkoutPath,
    branch: input.branch,
    label: input.label ?? basename3(checkoutPath),
    source: input.source,
    eventKey: input.eventKey ?? null,
    phase: "validate",
    deleteRemote: ownsRemote,
    deleteLocal: targetMatches && Number(managed.owns_local) === 1,
    remote: ownsRemote && managed?.remote ? String(managed.remote) : null,
    remoteUrl: ownsRemote && managed?.remote_url ? String(managed.remote_url) : null,
    remoteBranch: ownsRemote && managed?.remote_branch ? String(managed.remote_branch) : null,
    error: null
  };
  input.store.saveCleanupJob(job);
  return job;
}
function validate(job) {
  if (!job.branch) throw new WorkflowError("Cleanup stopped because branch metadata is missing");
  const primary = primaryWorktree(job.repoRoot);
  if (primary && canonical(primary.path) === canonical(job.checkoutPath)) {
    throw new WorkflowError(`Refusing to remove primary checkout ${job.checkoutPath}`);
  }
  const protectedSet = protectedBranches(job.repoRoot);
  if (protectedSet.has(job.branch) || job.remoteBranch && protectedSet.has(job.remoteBranch)) {
    throw new WorkflowError(`Refusing to remove protected branch ${job.branch}`);
  }
  if (job.deleteRemote && job.remote && job.remoteUrl) {
    const currentRemoteUrl = git(job.repoRoot, "remote", "get-url", job.remote);
    if (currentRemoteUrl !== job.remoteUrl) {
      throw new WorkflowError(`Remote ${job.remote} changed; refusing remote branch deletion`);
    }
  }
  const current = worktreeForPath(job.repoRoot, job.checkoutPath);
  if (current && current.branch !== job.branch) {
    throw new WorkflowError(`Worktree branch mismatch: expected ${job.branch}, found ${current.branch ?? "detached HEAD"}`);
  }
  const branchCheckout = worktreeForBranch(job.repoRoot, job.branch);
  if (branchCheckout && canonical(branchCheckout.path) !== canonical(job.checkoutPath)) {
    throw new WorkflowError(`Branch ${job.branch} is checked out at a different path: ${branchCheckout.path}`);
  }
}
function attemptCleanup(store, initial) {
  const owner = randomUUID2();
  const lockKey = `cleanup:${canonical(initial.repoRoot)}`;
  if (!store.acquireLock(lockKey, owner)) return false;
  let job = initial;
  try {
    while (true) {
      if (job.phase !== "prune") validate(job);
      if (job.phase === "validate") {
        job = { ...job, phase: "remote", error: null };
      } else if (job.phase === "remote") {
        if (job.deleteRemote && job.remote && job.remoteUrl && job.remoteBranch) {
          deleteRemoteBranch(job.repoRoot, job.remote, job.remoteBranch, job.remoteUrl);
        }
        job = { ...job, phase: "checkout", error: null };
      } else if (job.phase === "checkout") {
        removeWorktree(job.repoRoot, job.checkoutPath);
        job = { ...job, phase: "branch", error: null };
      } else if (job.phase === "branch") {
        if (job.deleteLocal) deleteLocalBranch(job.repoRoot, job.branch);
        job = { ...job, phase: "prune", error: null };
      } else {
        git(job.repoRoot, "worktree", "prune", "--expire", "now");
        store.transaction(() => {
          store.deleteCleanupJob(job.id);
          store.deleteManagedTarget(job.repoRoot, job.branch);
          if (job.eventKey) store.markEventComplete(job.eventKey);
        });
        store.log("info", "cleanup.completed", JSON.stringify({
          repo: job.repoRoot,
          checkout: job.checkoutPath,
          branch: job.branch,
          source: job.source
        }));
        return true;
      }
      store.saveCleanupJob(job);
    }
  } catch (error) {
    store.saveCleanupJob({ ...job, error: errorRecord(error) });
    store.log("error", "cleanup.failed", JSON.stringify({
      repo: job.repoRoot,
      checkout: job.checkoutPath,
      branch: job.branch,
      phase: job.phase,
      error: error instanceof Error ? error.message : String(error)
    }));
    return false;
  } finally {
    store.releaseLock(lockKey, owner);
  }
}
function retryCleanup(store, herdr = new HerdrClient()) {
  let failures = 0;
  for (const job of store.cleanupJobs()) {
    if (!attemptCleanup(store, job)) failures += 1;
  }
  if (failures) herdr.notify("Worktree cleanup failures remain", `${failures} cleanup job(s) require attention.`);
  return failures;
}
function eventMetadata(env) {
  const envelope = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON ?? "{}");
  const event = env.HERDR_PLUGIN_EVENT ?? envelope.event;
  const data = envelope.data ?? {};
  const workspace = data.workspace ?? {};
  const provenance = workspace.worktree ?? {};
  let context = {};
  try {
    context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  } catch {
  }
  const contextProvenance = context.worktree ?? {};
  if (event === "workspace.closed") {
    if (!provenance.is_linked_worktree) return null;
    return {
      repoRoot: provenance.repo_root ?? contextProvenance.repo_root,
      checkoutPath: provenance.checkout_path,
      branch: data.worktree?.branch ?? provenance.branch ?? "",
      label: workspace.label ?? "worktree",
      eventKey: data.workspace_id ?? workspace.workspace_id ?? ""
    };
  }
  if (event === "worktree.removed") {
    const tree = data.worktree ?? {};
    if (!tree.is_linked_worktree) return null;
    if (provenance.checkout_path && canonical(provenance.checkout_path) !== canonical(tree.path)) {
      throw new WorkflowError("Event workspace and worktree paths do not match");
    }
    return {
      repoRoot: provenance.repo_root ?? contextProvenance.repo_root,
      checkoutPath: tree.path,
      branch: tree.branch ?? "",
      label: tree.label ?? workspace.label ?? "worktree",
      eventKey: data.workspace_id ?? workspace.workspace_id ?? ""
    };
  }
  return null;
}
function handleCleanupEvent(store, env = process.env) {
  const metadata = eventMetadata(env);
  if (!metadata) return 0;
  if (!metadata.repoRoot || !metadata.checkoutPath) throw new WorkflowError("Linked-worktree event metadata is incomplete");
  if (store.eventCompleted(metadata.eventKey)) return 0;
  if (!metadata.branch) metadata.branch = worktreeForPath(metadata.repoRoot, metadata.checkoutPath)?.branch ?? "";
  const existing = store.cleanupJobs().find((job2) => job2.eventKey === metadata.eventKey || job2.repoRoot === canonical(metadata.repoRoot) && job2.checkoutPath === canonical(metadata.checkoutPath));
  if (!metadata.branch && existing) return attemptCleanup(store, existing) ? 0 : 1;
  const job = enqueueCleanup({ store, ...metadata, source: env.HERDR_PLUGIN_EVENT ?? "event" });
  return attemptCleanup(store, job) ? 0 : 1;
}
function cleanupReport(store) {
  const jobs = store.cleanupJobs();
  if (!jobs.length) return "No pending worktree cleanup failures.";
  return jobs.map((job) => [
    `${job.label} [${job.phase}]`,
    `  repo: ${job.repoRoot}`,
    `  path: ${job.checkoutPath}`,
    `  branch: ${job.branch || "(missing)"}`,
    `  local branch deletion: ${job.deleteLocal ? "enabled" : "preserved"}`,
    `  remote deletion: ${job.deleteRemote ? `${job.remote}/${job.remoteBranch}` : "preserved"}`,
    `  error: ${job.error ?? "pending retry"}`
  ].join("\n")).join("\n\n");
}

// src/doctor.ts
function doctor() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const checks = [
    ["Node.js 24+", nodeMajor >= 24, true],
    ["herdr 0.8+", commandOk("herdr", "--version"), true],
    [`opencode2 preview (${openCodeLabel()})`, openCodeOk(), true],
    ["git", commandOk("git", "--version"), true],
    ["fzf", commandOk("fzf", "--version"), true],
    ["gh", commandOk("gh", "--version"), false],
    ["pnpm", commandOk("pnpm", "--version"), true],
    ["nvim", commandOk("nvim", "--version"), false],
    ["lazygit", commandOk("lazygit", "--version"), false]
  ];
  console.log("Wheels Dev Workflow dependency check\n");
  for (const [name, ok, required] of checks) console.log(`${ok ? "ok" : required ? "missing" : "optional"}  ${name}`);
  return checks.some(([, ok, required]) => required && !ok) ? 1 : 0;
}
function commandOk(command, argument) {
  try {
    return run([executable(command), argument], { check: false }).exitCode === 0;
  } catch {
    return false;
  }
}
function openCodeOk() {
  try {
    openCodeCli();
    return true;
  } catch {
    return false;
  }
}
function openCodeLabel() {
  try {
    return openCodeVersion();
  } catch {
    return "unavailable";
  }
}

// src/worktrees.ts
import { existsSync as existsSync5, lstatSync as lstatSync2, mkdirSync as mkdirSync3, readdirSync as readdirSync2, symlinkSync } from "node:fs";
import { basename as basename4, dirname as dirname3, join as join2, relative, resolve as resolve7 } from "node:path";
function linkEnvironmentFiles(repo, checkout) {
  const primary = primaryWorktree(repo);
  if (!primary || canonical(primary.path) === canonical(checkout)) return;
  const apps = resolve7(primary.path, "apps");
  if (!existsSync5(apps)) return;
  for (const app of readdirSync2(apps, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const source = join2(apps, app.name, ".env");
    const destination = join2(checkout, relative(primary.path, source));
    if (!existsSync5(source) || existsSync5(destination)) continue;
    mkdirSync3(dirname3(destination), { recursive: true });
    symlinkSync(source, destination);
  }
}
function resolvePullRequest(repo, value) {
  const result = JSON.parse(awaitlessGh(repo, value));
  if (result.state !== "OPEN") throw new WorkflowError(`Pull request is not open: ${value}`);
  if (result.isCrossRepository) throw new WorkflowError("Cross-repository pull requests are not supported yet");
  if (!result.headRefName || !result.headRefOid) throw new WorkflowError(`Pull request has no usable head: ${value}`);
  const repositoryUrl = awaitlessGhRepository(repo).replace(/\/$/, "");
  if (!result.url?.startsWith(`${repositoryUrl}/pull/`)) {
    throw new WorkflowError(`Pull request does not belong to the current repository: ${value}`);
  }
  fetchOrigin(repo);
  const remoteOid = remoteBranchExists(repo, result.headRefName) ? awaitlessGit(repo, "rev-parse", `refs/remotes/origin/${result.headRefName}`) : "";
  if (remoteOid !== result.headRefOid) throw new WorkflowError(`Pull request head changed or is unavailable on origin: ${value}`);
  return result.headRefName;
}
function awaitlessGh(repo, value) {
  const { run: run2 } = requireProcess();
  return run2([
    "gh",
    "pr",
    "view",
    value,
    "--json",
    "state,headRefName,headRefOid,isCrossRepository,url"
  ], { cwd: repo }).stdout;
}
function awaitlessGhRepository(repo) {
  const { run: run2 } = requireProcess();
  return run2(["gh", "repo", "view", "--json", "url", "--jq", ".url"], { cwd: repo }).stdout.trim();
}
function awaitlessGit(repo, ...args) {
  const { run: run2 } = requireProcess();
  return run2(["git", "-C", repo, ...args]).stdout.trim();
}
function requireProcess() {
  return process_exports;
}
function prepareTarget(input) {
  const repo = canonical(input.repoRoot);
  input.store.rememberRepository(repo);
  let branch = "";
  let checkout = "";
  let opened;
  if (input.target.kind === "new") {
    const slug = slugify(input.target.value);
    branch = `wheels/${slug}`;
    checkout = managedWorktreePath(repo, slug);
    const sync = synchronizeDefaultBranch(repo);
    if (["dirty", "diverged"].includes(sync)) throw new WorkflowError(`Default branch synchronization blocked: ${sync}`);
    if (localBranchExists(repo, branch) || remoteBranchExists(repo, branch)) {
      throw new WorkflowError(`Branch already exists; dispatch it as an existing branch instead: ${branch}`);
    }
    createWorktree(repo, checkout, branch, defaultBaseRef(repo));
    input.store.registerManagedTarget({
      repoRoot: repo,
      branch,
      checkoutPath: checkout,
      createdOid: branchHead(repo, branch),
      ownsLocal: true,
      ...hasOrigin(repo) ? { remote: "origin", remoteUrl: remoteUrl(repo), remoteBranch: branch, ownsRemote: true } : {}
    });
  } else {
    branch = input.target.kind === "pr" ? resolvePullRequest(repo, input.target.value) : input.target.value.trim().replace(/^origin\//, "");
    if (!branch) throw new WorkflowError("Existing branch target must not be empty");
    fetchOrigin(repo);
    const existing = worktreeForBranch(repo, branch);
    const primary = primaryWorktree(repo);
    if (existing && primary && canonical(existing.path) === canonical(primary.path)) {
      throw new WorkflowError(`Refusing to dispatch into the primary checkout: ${branch}`);
    }
    let ownsLocal = false;
    if (existing) {
      checkout = existing.path;
      ownsLocal = Number(input.store.managedTarget(repo, branch)?.owns_local ?? 0) === 1;
    } else {
      checkout = managedWorktreePath(repo, safeWorktreeName(branch));
      const tracking = createTrackingWorktree(repo, checkout, branch);
      ownsLocal = tracking.createdLocalBranch;
    }
    input.store.registerManagedTarget({
      repoRoot: repo,
      branch,
      checkoutPath: checkout,
      createdOid: branchHead(repo, branch),
      ownsLocal,
      ...hasOrigin(repo) ? { remote: "origin", remoteUrl: remoteUrl(repo), remoteBranch: branch } : {}
    });
  }
  const label = basename4(checkout);
  linkEnvironmentFiles(repo, checkout);
  opened = input.herdr.openWorktree(repo, checkout, label);
  const panes = input.herdr.panes(opened.workspaceId);
  const activePane = panes.find((pane) => ["working", "blocked"].includes(String(pane.agent_status ?? "unknown")));
  if (activePane) {
    const status = String(activePane.agent_status);
    throw new WorkflowError(
      `Dispatch target ${branch} is already in use by a ${status} agent in workspace ${opened.workspaceId}, pane ${String(activePane.pane_id)}. Finish or stop that agent before dispatching to this target.`
    );
  }
  const shellPaneId = panes.length > 1 ? String(panes.find((pane) => String(pane.pane_id) !== opened.rootPaneId)?.pane_id ?? "") : input.herdr.splitPane(opened.rootPaneId, checkout);
  if (!shellPaneId) throw new WorkflowError("Could not identify the target shell pane");
  input.herdr.runInstall(shellPaneId, checkout);
  return {
    kind: input.target.kind,
    repoRoot: repo,
    branch,
    checkoutPath: checkout,
    label,
    workspaceId: opened.workspaceId,
    rootPaneId: opened.rootPaneId,
    shellPaneId
  };
}

// src/dispatch.ts
function handoff(checkout, request2) {
  return `Implement the requested change directly in ${checkout}.

Do not dispatch again or create another worktree. Preserve unrelated changes. Do not commit or push unless the request explicitly asks.

Request:
${request2}`;
}
function liveHub(hub) {
  const herdr = new HerdrClient(hub.herdrBin, hub.socketPath ?? void 0);
  try {
    return herdr.tabs().some((tab) => String(tab.tab_id) === hub.tabId) && herdr.panes(hub.workspaceId).some((pane) => String(pane.pane_id) === hub.paneId);
  } catch {
    return false;
  }
}
function resolveHub(projectRoot, store, env = process.env) {
  const registered = store.hub(projectRoot);
  if (registered && liveHub(registered)) return registered;
  const environmentRoot = env.HERDR_PROJECT_ROOT;
  if (environmentRoot && canonical(environmentRoot) === projectRoot) {
    try {
      const recovered = {
        projectRoot,
        ...currentHerdrIdentity(env),
        herdrBin: env.HERDR_BIN_PATH ?? "herdr",
        socketPath: env.HERDR_SOCKET_PATH ?? null
      };
      if (liveHub(recovered)) {
        store.registerHub(recovered);
        return recovered;
      }
    } catch {
    }
  }
  if (registered) store.deleteHub(projectRoot, registered.paneId);
  throw new WorkflowError("This repository does not have a live Herdr Project Chat hub");
}
async function dispatchImplementation(request2, store = new StateStore()) {
  const source = await getSession(request2.sourceSessionId);
  const projectRoot = primaryRepository(source.location.directory);
  if (!projectRoot) throw new WorkflowError("This OpenCode session is not inside a Git repository");
  const hub = resolveHub(projectRoot, store);
  const text = request2.request.trim();
  const target = request2.target.trim();
  if (!text || !target) throw new WorkflowError("Dispatch request and target must not be empty");
  if (!store.beginDispatch({
    sourceSessionId: request2.sourceSessionId,
    sourceMessageId: request2.sourceMessageId,
    projectRoot,
    request: "",
    targetKind: request2.targetKind,
    targetValue: target
  })) {
    throw new WorkflowError("This dispatch turn has already been accepted; do not retry it");
  }
  const herdr = new HerdrClient(hub.herdrBin, hub.socketPath ?? void 0);
  let implementationSessionId;
  let prepared;
  let promptStarted = false;
  try {
    prepared = prepareTarget({
      repoRoot: projectRoot,
      target: { kind: request2.targetKind, value: target },
      store,
      herdr
    });
    store.updateDispatch(request2.sourceSessionId, request2.sourceMessageId, {
      status: "preparing",
      branch: prepared.branch,
      checkoutPath: prepared.checkoutPath
    });
    const fork = await forkSession(request2.sourceSessionId, request2.sourceMessageId);
    implementationSessionId = fork.id;
    store.updateDispatch(request2.sourceSessionId, request2.sourceMessageId, {
      status: "preparing",
      implementationSessionId: fork.id
    });
    await prepareImplementationSession(fork.id, prepared.checkoutPath);
    await renameSession(fork.id, source.title?.trim() || prepared.branch);
    herdr.launchOpenCode(prepared.rootPaneId, prepared.checkoutPath, fork.id);
    await promptSession(fork.id, handoff(prepared.checkoutPath, text), () => {
      promptStarted = true;
    });
    try {
      store.updateDispatch(request2.sourceSessionId, request2.sourceMessageId, {
        status: "delivered",
        implementationSessionId: fork.id
      });
    } catch (error) {
      herdr.notify("Dispatch bookkeeping incomplete", `Implementation started, but its receipt could not be updated: ${error}. Do not redispatch.`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (promptStarted) {
      try {
        store.updateDispatch(request2.sourceSessionId, request2.sourceMessageId, {
          status: "delivery_unknown",
          ...implementationSessionId ? { implementationSessionId } : {},
          error: detail
        });
      } catch {
      }
      throw new WorkflowError(`OpenCode prompt delivery could not be confirmed. The implementation workspace was preserved; inspect it and do not redispatch. ${detail}`);
    }
    store.deleteDispatch(request2.sourceSessionId, request2.sourceMessageId);
    const location = prepared ? ` Artifacts were preserved at ${prepared.checkoutPath} on ${prepared.branch}.` : " Any artifacts created before the failure were preserved.";
    throw new WorkflowError(`Dispatch stopped before implementation prompting.${location} ${detail}`);
  }
  return `Implementation started in ${prepared.branch} at ${prepared.checkoutPath}. Do not dispatch this request again.`;
}

// src/projects.ts
import { existsSync as existsSync6, lstatSync as lstatSync3, mkdirSync as mkdirSync4, readSync, readdirSync as readdirSync3 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { resolve as resolve8 } from "node:path";
function prompt(label, fallback) {
  process.stdout.write(`${label}${fallback ? ` [${fallback}]` : ""}: `);
  const buffer = Buffer.alloc(4096);
  const count = readSync(0, buffer, 0, buffer.length, null);
  const value = buffer.subarray(0, count).toString("utf8").trim();
  return value || fallback || "";
}
function normalizeProjectName(value) {
  const name = value.trim();
  if (!name || name === "." || name === "..") throw new WorkflowError("Project name must be one non-empty directory name");
  if (/[\\/\0\x00-\x1f\x7f]/.test(name)) throw new WorkflowError("Project name cannot contain separators or control characters");
  return name;
}
function createBlankProject(input, store = new StateStore()) {
  const name = normalizeProjectName(input.name);
  const parent = canonical(input.parent);
  if (!existsSync6(parent) || !lstatSync3(parent).isDirectory()) throw new WorkflowError(`Parent directory does not exist: ${parent}`);
  const destination = resolve8(parent, name);
  if (existsSync6(destination)) {
    if (lstatSync3(destination).isSymbolicLink()) throw new WorkflowError(`Project destination must not be a symlink: ${destination}`);
    if (readdirSync3(destination).length) throw new WorkflowError(`Project destination is not empty: ${destination}`);
  } else {
    mkdirSync4(destination);
  }
  run(["git", "init", "-b", "main", destination]);
  run(["git", "-C", destination, "commit", "--allow-empty", "-m", "Initial commit"]);
  let githubError;
  if (input.github) {
    try {
      run(["gh", "auth", "status"]);
      run(["gh", "repo", "create", name, `--${input.visibility ?? "private"}`, "--source", ".", "--remote", "origin"], { cwd: destination });
      run(["git", "push", "-u", "origin", "main"], { cwd: destination });
    } catch (error) {
      githubError = error instanceof Error ? error.message : String(error);
    }
  }
  store.rememberRepository(destination);
  openChat(destination);
  return githubError ? { destination, githubError } : { destination };
}
function interactiveBlankProject() {
  const name = prompt("Project name");
  if (!name) return 0;
  const parent = prompt("Parent directory", resolve8(homedir5(), "Projects"));
  const github = /^y(es)?$/i.test(prompt("Create GitHub repository (yes/no)", "no"));
  const visibility = github && /^pub/i.test(prompt("GitHub visibility (private/public)", "private")) ? "public" : "private";
  const result = createBlankProject({ name, parent, github, visibility });
  console.log(`Created local repository: ${result.destination}`);
  if (result.githubError) {
    console.error(`GitHub setup failed; local project was kept and opened.
${result.githubError}`);
    return 1;
  }
  return 0;
}

// src/cli.ts
async function main(args = process.argv.slice(2)) {
  const command = args[0];
  const store = new StateStore();
  if (command === "startup") {
    ensureCompanionInstalled();
    await ensureOpenCodeReady();
    return retryCleanup(store);
  }
  if (command === "event") return handleCleanupEvent(store);
  if (command === "retry-cleanup") return retryCleanup(store);
  if (command === "show-cleanup") {
    console.log(cleanupReport(store));
    return store.cleanupJobs().length ? 1 : 0;
  }
  if (command === "workflow-status") {
    const dependencyStatus = doctor();
    const cleanupFailures = retryCleanup(store);
    console.log(`
Cleanup

${cleanupReport(store)}`);
    const activity = store.recentLogs(100).filter((entry) => entry.kind.startsWith("auto-prune.") || entry.kind.startsWith("cleanup.")).slice(0, 20).reverse();
    console.log("\nRecent pruning and cleanup activity\n");
    if (!activity.length) console.log("No pruning or cleanup activity recorded yet.");
    for (const entry of activity) {
      console.log(`${new Date(entry.createdAt).toISOString()} ${entry.level} ${entry.kind}: ${entry.message}`);
    }
    return dependencyStatus || cleanupFailures ? 1 : 0;
  }
  if (command === "scan-merged") {
    console.log(JSON.stringify(scanMerged(store)));
    return 0;
  }
  if (command === "watch-merged") {
    await watchMerged(store);
    return 0;
  }
  if (command === "chat-current") {
    await chatCurrent();
    return 0;
  }
  if (command === "chat-picker") {
    await openChatPicker();
    return 0;
  }
  if (command === "run-chat") return await runChatPane();
  if (command === "dispatch-tool") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    console.log(await dispatchImplementation(input, store));
    return 0;
  }
  if (command === "blank-project") return interactiveBlankProject();
  if (command === "doctor") return doctor();
  if (command === "logs") {
    for (const entry of store.recentLogs()) console.log(`${new Date(entry.createdAt).toISOString()} ${entry.level} ${entry.kind}: ${entry.message}`);
    return 0;
  }
  if (command === "open-pane") {
    const entrypoint = args[1];
    if (!entrypoint) throw new WorkflowError("Missing pane entrypoint");
    const context = pluginContext();
    const cwd = String(context.focused_pane_cwd ?? context.workspace_cwd ?? process.cwd());
    new HerdrClient().openPluginPane(entrypoint, { cwd });
    return 0;
  }
  throw new WorkflowError(`Unknown command: ${command ?? "(missing)"}`);
}
main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  const message = error instanceof Error ? `${error.message}${error.stack ? `
${error.stack}` : ""}` : String(error);
  console.error(message);
  try {
    new StateStore().log("error", `cli.${process.argv[2] ?? "unknown"}`, message);
  } catch {
  }
  if (process.argv[2] === "run-chat" && process.stdin.isTTY) {
    process.stderr.write("\nPress enter to close...");
    try {
      readSync2(0, Buffer.alloc(1), 0, 1, null);
    } catch {
    }
  }
  process.exitCode = 1;
});
