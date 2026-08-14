import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { WorkflowError } from "./errors.js"
import { canonical } from "./paths.js"
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

interface LocationInfo {
  directory: string
  workspaceID?: string
}

interface LocationResponse extends LocationInfo {
  project: { id: string; directory: string; canonical: string }
}

interface CatalogResponse {
  location: LocationResponse
  data: unknown[]
}

type ReadinessRequest = (path: string, timeout: number) => Promise<unknown>

export interface SessionLocationReadinessOptions {
  timeoutMs?: number
  intervalMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  request?: ReadinessRequest
}

class OpenCodeApiError extends WorkflowError {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = "OpenCodeApiError"
  }
}

class LocationNotReadyError extends Error {}

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
  if (!response.ok) throw new OpenCodeApiError(response.status, `OpenCode API ${method} ${path} failed (${response.status}): ${await response.text()}`)
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

export async function findForkedSession(sourceSessionId: string, sourceMessageId: string, createdAfter: number): Promise<SessionInfo | null> {
  const response = await request<{ data: SessionInfo[] }>("GET", "/api/session")
  return response.data
    .filter((session) => session.fork?.sessionID === sourceSessionId
      && session.fork.boundary.type === "before"
      && session.fork.boundary.messageID === sourceMessageId
      && session.time.created >= createdAfter)
    .sort((left, right) => right.time.created - left.time.created)[0] ?? null
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

function locationPath(path: string, location: LocationInfo): string {
  const query = new URLSearchParams()
  query.set("location[directory]", location.directory)
  if (location.workspaceID) query.set("location[workspace]", location.workspaceID)
  return `${path}?${query}`
}

function assertLocation(response: LocationInfo, expected: string, source: string): void {
  const actual = canonical(response.directory)
  if (actual !== expected) throw new LocationNotReadyError(`${source} resolved to ${actual}, expected ${expected}`)
}

function retryableReadinessError(error: unknown): boolean {
  if (!(error instanceof OpenCodeApiError)) return true
  return error.status === 404 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500
}

export async function waitForSessionLocationReady(
  sessionId: string,
  directory: string,
  options: SessionLocationReadinessOptions = {},
): Promise<void> {
  const expected = canonical(directory)
  const timeoutMs = options.timeoutMs ?? 45_000
  const intervalMs = options.intervalMs ?? 250
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds)))
  const deadline = now() + timeoutMs
  let readinessRequest = options.request
  if (!readinessRequest) {
    const info = await service()
    readinessRequest = async (path, timeout) => await requestWithService(info, "GET", path, undefined, timeout)
  }
  let lastError: unknown
  const probe = async (path: string): Promise<unknown> => {
    const remaining = deadline - now()
    if (remaining <= 0) throw new LocationNotReadyError("Readiness deadline expired")
    return await readinessRequest(path, Math.min(2_000, remaining))
  }

  while (now() < deadline) {
    try {
      const sessionResponse = await probe(`/api/session/${encodeURIComponent(sessionId)}`) as { data: SessionInfo }
      assertLocation(sessionResponse.data.location, expected, "Session")
      const location = sessionResponse.data.location

      const resolved = await probe(locationPath("/api/location", location)) as LocationResponse
      assertLocation(resolved, expected, "Location")

      const models = await probe(locationPath("/api/model", location)) as CatalogResponse
      assertLocation(models.location, expected, "Model catalog")
      if (!Array.isArray(models.data)) throw new LocationNotReadyError("Model catalog is not available")

      const agents = await probe(locationPath("/api/agent", location)) as CatalogResponse
      assertLocation(agents.location, expected, "Agent catalog")
      if (!agents.data.some((agent) => typeof agent === "object" && agent !== null && "id" in agent && agent.id === "build")) {
        throw new LocationNotReadyError("Build agent is not available in the destination catalog")
      }
      return
    } catch (error) {
      if (!retryableReadinessError(error)) throw error
      lastError = error
      const delay = Math.min(intervalMs, deadline - now())
      if (delay > 0) await sleep(delay)
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "destination services remained unavailable")
  throw new WorkflowError(`OpenCode destination did not become ready within ${timeoutMs}ms for ${expected}: ${detail}`, lastError)
}

export async function promptSession(sessionId: string, text: string, onAttempt?: () => void): Promise<void> {
  const info = await service()
  onAttempt?.()
  await requestWithService(info, "POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text })
}
