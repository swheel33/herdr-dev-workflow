import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { WorkflowError } from "./errors.js"
import { executable, run } from "./process.js"

export interface SessionInfo {
  id: string
  parentID?: string
  fork?: { sessionID: string; boundary: { type: "before" | "through"; messageID?: string } }
  projectID: string
  agent?: string
  title?: string
  location: { directory: string; workspaceID?: string }
  time: { created: number; updated: number; archived?: number }
}

interface ServiceInfo {
  url: string
  password?: string
  version?: string
}

export const PROJECT_CHAT_ENVIRONMENT = [
  "HERDR_PROJECT_CHAT",
  "HERDR_PROJECT_ROOT",
] as const

const HERDR_SESSION_ENVIRONMENT = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_PLUGIN_CONTEXT_JSON",
  "HERDR_PLUGIN_EVENT",
  "HERDR_PLUGIN_EVENT_JSON",
  "HERDR_PLUGIN_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  ...PROJECT_CHAT_ENVIRONMENT,
] as const

export function sharedOpenCodeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = { ...env }
  for (const name of HERDR_SESSION_ENVIRONMENT) delete sanitized[name]
  return sanitized
}

function servicePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.XDG_STATE_HOME ?? resolve(homedir(), ".local/state"), "opencode/service.json")
}

function readService(env: NodeJS.ProcessEnv = process.env): ServiceInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(servicePath(env), "utf8")) as ServiceInfo
    return parsed.url ? parsed : null
  } catch {
    return null
  }
}

function cliIdentity(env: NodeJS.ProcessEnv = process.env): { binary: string; version: string } {
  const binary = executable("opencode2", env)
  const result = run([binary, "--version"], { check: false, env })
  const version = result.stdout.match(/0\.0\.0-next-\d+/)?.[0]
  if (result.exitCode !== 0 || !version) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
    throw new WorkflowError(`OpenCode 2 CLI is not executable: ${detail}`)
  }
  return { binary, version }
}

async function healthy(info: ServiceInfo): Promise<boolean> {
  try {
    await requestWithService(info, "GET", "/api/health", undefined, 5_000)
    return true
  } catch {
    return false
  }
}

async function service(env: NodeJS.ProcessEnv = process.env): Promise<ServiceInfo> {
  const sharedEnv = sharedOpenCodeEnvironment(env)
  const cli = cliIdentity(sharedEnv)
  let info = readService(sharedEnv)
  if (info?.version === cli.version && await healthy(info)) return info

  run([cli.binary, "service", info ? "restart" : "start"], { env: sharedEnv })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    info = readService(sharedEnv)
    if (info?.version === cli.version && await healthy(info)) return info
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  const actual = info?.version ?? "missing"
  throw new WorkflowError(`OpenCode 2 service did not become healthy on CLI version ${cli.version} (service: ${actual})`)
}

export function openCodeCli(env: NodeJS.ProcessEnv = process.env): string {
  return cliIdentity(env).binary
}

export function openCodeVersion(env: NodeJS.ProcessEnv = process.env): string {
  return cliIdentity(env).version
}

export function ensureOpenCodeCompatible(env: NodeJS.ProcessEnv = process.env): void {
  const cli = cliIdentity(env)
  const help = run([cli.binary, "--help"], { check: false, env })
  if (help.exitCode !== 0 || !help.stdout.includes("--session") || !help.stdout.includes("--standalone")) {
    throw new WorkflowError("OpenCode 2 full TUI does not expose the required --session and --standalone options")
  }
}

export async function ensureOpenCodeReady(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  ensureOpenCodeCompatible(env)
  await service(env)
}

async function requestWithService<T>(info: ServiceInfo, method: string, path: string, body?: unknown, timeout = 30_000): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (info.password) headers.authorization = `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`
  const response = await fetch(new URL(path, info.url), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw new WorkflowError(`OpenCode API ${method} ${path} failed (${response.status}): ${await response.text()}`)
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

async function request<T>(method: string, path: string, body?: unknown, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  return await requestWithService<T>(await service(env), method, path, body)
}

export async function forkSession(sourceSessionId: string, sourceMessageId: string): Promise<SessionInfo> {
  const response = await request<{ data: SessionInfo }>("POST", `/api/session/${encodeURIComponent(sourceSessionId)}/fork`, {
    boundary: { type: "before", messageID: sourceMessageId },
  })
  return response.data
}

export async function getSession(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<SessionInfo> {
  const response = await request<{ data: SessionInfo }>("GET", `/api/session/${encodeURIComponent(sessionId)}`, undefined, env)
  return response.data
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  await request("POST", `/api/session/${encodeURIComponent(sessionId)}/rename`, { title })
}

export async function prepareImplementationSession(sessionId: string, directory: string): Promise<void> {
  await request("POST", `/api/session/${encodeURIComponent(sessionId)}/move`, { directory })
  await request("POST", `/api/session/${encodeURIComponent(sessionId)}/agent`, { agent: "build" })
}

export async function promptSession(sessionId: string, text: string, onAttempt?: () => void): Promise<void> {
  const info = await service()
  onAttempt?.()
  await requestWithService(info, "POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text })
}
