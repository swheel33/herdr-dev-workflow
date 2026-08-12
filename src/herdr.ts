import { WorkflowError } from "./errors.js"
import { openCodeCli, PROJECT_CHAT_ENVIRONMENT } from "./opencode.js"
import { run, shellQuote } from "./process.js"

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowError("Herdr returned invalid JSON")
  return value as JsonObject
}

export class HerdrClient {
  constructor(
    readonly binary = process.env.HERDR_BIN_PATH ?? "herdr",
    readonly socketPath = process.env.HERDR_SOCKET_PATH,
  ) {}

  private env(): NodeJS.ProcessEnv {
    return this.socketPath ? { ...process.env, HERDR_SOCKET_PATH: this.socketPath } : process.env
  }

  command(args: readonly string[], check = true): { stdout: string; stderr: string; exitCode: number } {
    return run([this.binary, ...args], { check, env: this.env() })
  }

  json(args: readonly string[]): JsonObject {
    const parsed: unknown = JSON.parse(this.command(args).stdout)
    const envelope = object(parsed)
    if (envelope.error) throw new WorkflowError(JSON.stringify(envelope.error))
    return object(envelope.result ?? envelope)
  }

  notify(title: string, body: string): void {
    this.command(["notification", "show", title.slice(0, 80), "--body", body.slice(0, 240), "--sound", "none"], false)
  }

  workspaces(): JsonObject[] {
    const result = this.json(["workspace", "list"])
    return Array.isArray(result.workspaces) ? result.workspaces.map(object) : []
  }

  panes(workspaceId?: string): JsonObject[] {
    const args = ["pane", "list", ...(workspaceId ? ["--workspace", workspaceId] : [])]
    const result = this.json(args)
    return Array.isArray(result.panes) ? result.panes.map(object) : []
  }

  tabs(): JsonObject[] {
    const result = this.json(["tab", "list"])
    return Array.isArray(result.tabs) ? result.tabs.map(object) : []
  }

  runningSessionCount(): number {
    const result = this.json(["session", "list", "--json"])
    const sessions = Array.isArray(result.sessions) ? result.sessions.map(object) : []
    return sessions.filter((session) => session.running === true).length
  }

  focusWorkspace(workspaceId: string): void {
    this.command(["workspace", "focus", workspaceId])
  }

  openWorktree(repo: string, checkout: string, label: string): { workspaceId: string; rootPaneId: string; alreadyOpen: boolean } {
    const result = this.json([
      "worktree", "open", "--cwd", repo, "--path", checkout, "--label", label, "--no-focus", "--json",
    ])
    const workspace = object(result.workspace)
    const rootPane = result.root_pane ? object(result.root_pane) : null
    const workspaceId = String(workspace.workspace_id ?? "")
    const existingPanes = workspaceId ? this.panes(workspaceId) : []
    const rootPaneId = String(rootPane?.pane_id ?? existingPanes[0]?.pane_id ?? "")
    if (!workspaceId || !rootPaneId) throw new WorkflowError("Herdr did not return workspace and root pane identities")
    return { workspaceId, rootPaneId, alreadyOpen: result.already_open === true }
  }

  splitPane(rootPaneId: string, checkout: string): string {
    const result = this.json(["pane", "split", rootPaneId, "--direction", "down", "--ratio", "0.70", "--cwd", checkout, "--no-focus"])
    const pane = result.pane ? object(result.pane) : result
    const id = String(pane.pane_id ?? "")
    if (!id) throw new WorkflowError("Herdr did not return the shell pane identity")
    return id
  }

  runInPane(paneId: string, command: string): void {
    this.command(["pane", "run", paneId, command])
  }

  launchOpenCode(paneId: string, checkout: string, sessionId: string): void {
    const unset = PROJECT_CHAT_ENVIRONMENT.map((name) => `-u ${name}`).join(" ")
    this.runInPane(paneId, `exec env ${unset} ${shellQuote(openCodeCli())} ${shellQuote(checkout)} --session ${shellQuote(sessionId)}`)
  }

  runInstall(paneId: string, checkout: string): void {
    this.runInPane(paneId, `cd -- ${shellQuote(checkout)} && pnpm install`)
  }

  closeWorkspace(workspaceId: string): void {
    this.command(["workspace", "close", workspaceId])
    if (this.workspaces().some((workspace) => workspace.workspace_id === workspaceId)) {
      throw new WorkflowError(`Herdr workspace did not close: ${workspaceId}`)
    }
  }

  closeTab(tabId: string): void {
    this.command(["tab", "close", tabId])
  }

  openPluginPane(entrypoint: string, options: {
    cwd: string
    workspaceId?: string
    placement?: "tab" | "split"
    targetPane?: string
    direction?: "right" | "down"
    focus?: boolean
    env?: Record<string, string>
  }): JsonObject {
    const args = [
      "plugin", "pane", "open", "--plugin", process.env.HERDR_PLUGIN_ID ?? "wheels.dev-workflow",
      "--entrypoint", entrypoint, "--cwd", options.cwd,
    ]
    if (options.workspaceId && !options.targetPane) args.push("--workspace", options.workspaceId)
    if (options.placement) args.push("--placement", options.placement)
    if (options.targetPane) args.push("--target-pane", options.targetPane)
    if (options.direction) args.push("--direction", options.direction)
    for (const [key, value] of Object.entries(options.env ?? {})) args.push("--env", `${key}=${value}`)
    args.push(options.focus === false ? "--no-focus" : "--focus")
    return this.json(args)
  }
}

export function pluginContext(env: NodeJS.ProcessEnv = process.env): JsonObject {
  try {
    return object(JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}"))
  } catch {
    return {}
  }
}

export function currentHerdrIdentity(env: NodeJS.ProcessEnv = process.env): {
  paneId: string
  tabId: string
  workspaceId: string
} {
  const context = pluginContext(env)
  const paneId = env.HERDR_PANE_ID ?? String(context.pane_id ?? "")
  const tabId = env.HERDR_TAB_ID ?? String(context.tab_id ?? "")
  const workspaceId = env.HERDR_WORKSPACE_ID ?? String(context.workspace_id ?? "")
  if (!paneId || !tabId || !workspaceId) throw new WorkflowError("Herdr pane, tab, or workspace identity is missing")
  return { paneId, tabId, workspaceId }
}
