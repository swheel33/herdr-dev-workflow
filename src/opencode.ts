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
}

function servicePath(): string {
  return resolve(process.env.XDG_STATE_HOME ?? resolve(homedir(), ".local/state"), "opencode/service.json")
}

function readService(): ServiceInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(servicePath(), "utf8")) as ServiceInfo
    return parsed.url ? parsed : null
  } catch {
    return null
  }
}

async function service(): Promise<ServiceInfo> {
  let info = readService()
  if (!info) {
    run([executable("opencode2"), "service", "start"])
    const deadline = Date.now() + 30_000
    while (!(info = readService()) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
  }
  if (!info) throw new WorkflowError("OpenCode 2 background service did not start")
  await requestWithService(info, "GET", "/api/health", undefined, 5_000)
  return info
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return await requestWithService<T>(await service(), method, path, body)
}

export async function createSession(directory: string, title = "New Chat"): Promise<SessionInfo> {
  const response = await request<{ data: SessionInfo }>("POST", "/api/session", { title, agent: "project-chat", location: { directory } })
  return response.data
}

export async function forkSession(sourceSessionId: string, sourceMessageId: string): Promise<SessionInfo> {
  const response = await request<{ data: SessionInfo }>("POST", `/api/session/${encodeURIComponent(sourceSessionId)}/fork`, {
    boundary: { type: "before", messageID: sourceMessageId },
  })
  return response.data
}

export async function continueSession(sourceSessionId: string, directory: string): Promise<SessionInfo> {
  const response = await request<{ data: SessionInfo }>("POST", `/api/session/${encodeURIComponent(sourceSessionId)}/fork`, {
    boundary: { type: "through" },
  })
  const fork = response.data
  await request("POST", `/api/session/${encodeURIComponent(fork.id)}/move`, { directory })
  await request("POST", `/api/session/${encodeURIComponent(fork.id)}/agent`, { agent: "project-chat" })
  return fork
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

export async function removeSession(sessionId: string): Promise<void> {
  await request("DELETE", `/api/session/${encodeURIComponent(sessionId)}`)
}

export async function projectSessions(directory: string): Promise<SessionInfo[]> {
  const locationQuery = new URLSearchParams({ "location[directory]": directory })
  const location = await request<{ project: { id: string } }>("GET", `/api/location?${locationQuery}`)
  const sessions: SessionInfo[] = []
  let cursor: string | undefined
  do {
    const query = new URLSearchParams({ project: location.project.id, order: "desc", limit: "100" })
    if (cursor) query.set("cursor", cursor)
    const page = await request<{ data: SessionInfo[]; cursor: { next?: string } }>("GET", `/api/session?${query}`)
    sessions.push(...page.data)
    cursor = page.cursor.next
  } while (cursor)
  return sessions
}
