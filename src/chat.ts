import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { spawn } from "node:child_process"
import { WorkflowError } from "./errors.js"
import { primaryRepository } from "./git.js"
import { currentHerdrIdentity, HerdrClient, pluginContext } from "./herdr.js"
import { canonical, pluginRoot, stateDirectory } from "./paths.js"
import { continueSession, createSession, openCodeCli, projectSessions } from "./opencode.js"
import { executable, run } from "./process.js"
import { StateStore } from "./state.js"

const CHAT_TITLE = "New Chat"

export function ensureCompanionInstalled(env: NodeJS.ProcessEnv = process.env): string {
  const source = resolve(pluginRoot(env), "dist/opencode-plugin.mjs")
  if (!existsSync(source)) throw new WorkflowError(`OpenCode companion bundle is missing: ${source}`)
  const configHome = resolve(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "plugins")
  mkdirSync(configHome, { recursive: true })
  const legacyDestination = resolve(configHome, "wheels-dev-workflow.mjs")
  if (lstatMaybe(legacyDestination)) {
    const stat = lstatSync(legacyDestination)
    if (stat.isSymbolicLink() || readFileSync(legacyDestination, "utf8").startsWith("// Managed by Wheels Dev Workflow")) {
      unlinkSync(legacyDestination)
    } else {
      throw new WorkflowError(`Refusing to replace unmanaged OpenCode plugin: ${legacyDestination}`)
    }
  }
  const destination = resolve(configHome, "wheels-dev-workflow.js")
  if (lstatMaybe(destination)) {
    const stat = lstatSync(destination)
    if (stat.isSymbolicLink()) {
      unlinkSync(destination)
    } else if (!readFileSync(destination, "utf8").startsWith("// Managed by Wheels Dev Workflow")) {
      throw new WorkflowError(`Refusing to replace unmanaged OpenCode plugin: ${destination}`)
    }
  }
  const sourceUrl = pathToFileURL(source).href
  const herdrBin = executable(env.HERDR_BIN_PATH ?? "herdr", env)
  writeFileSync(destination, `// Managed by Wheels Dev Workflow
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
let plugin = {}
if (existsSync(source) && enabled()) plugin = (await import(sourceUrl)).default
export default plugin
`)
  const configPath = resolve(configHome, "..", "opencode.jsonc")
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "{}\n"
  const parseErrors: ParseError[] = []
  const parsed = parse(config, parseErrors) as { plugins?: unknown } | undefined
  if (parseErrors.length || !parsed || typeof parsed !== "object") {
    throw new WorkflowError(`Refusing to modify invalid OpenCode config: ${configPath}`)
  }
  if (parsed.plugins !== undefined && !Array.isArray(parsed.plugins)) {
    throw new WorkflowError(`OpenCode config plugins must be an array: ${configPath}`)
  }
  const plugins = parsed.plugins ?? []
  const loaderUrl = pathToFileURL(destination).href
  const legacyLoaderUrl = pathToFileURL(legacyDestination).href
  const entry = {
    package: loaderUrl,
    options: { pluginRoot: pluginRoot(env), stateDir: stateDirectory(env) },
  }
  const retained = plugins.filter((item) => {
    if (item === loaderUrl || item === legacyLoaderUrl) return false
    return !(item && typeof item === "object" && "package" in item && [loaderUrl, legacyLoaderUrl].includes(String((item as { package?: unknown }).package)))
  })
  if (JSON.stringify(plugins) !== JSON.stringify([...retained, entry])) {
    const edits = modify(config, ["plugins"], [...retained, entry], {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    })
    writeFileSync(configPath, applyEdits(config, edits))
  }
  return destination
}

function lstatMaybe(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

function currentProjectRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const context = pluginContext(env)
  for (const candidate of [context.focused_pane_cwd, context.workspace_cwd, process.cwd()]) {
    if (typeof candidate !== "string") continue
    const root = primaryRepository(candidate)
    if (root) return root
  }
  return null
}

function primaryWorkspace(root: string, herdr: HerdrClient): { workspaceId: string; bootstrapPaneId?: string } {
  for (const workspace of herdr.workspaces()) {
    const provenance = workspace.worktree as Record<string, unknown> | undefined
    if (provenance?.is_linked_worktree === false && provenance.checkout_path && canonical(String(provenance.checkout_path)) === root) {
      return { workspaceId: String(workspace.workspace_id) }
    }
  }
  const opened = herdr.openWorktree(root, root, basename(root))
  return opened.alreadyOpen
    ? { workspaceId: opened.workspaceId }
    : { workspaceId: opened.workspaceId, bootstrapPaneId: opened.rootPaneId }
}

export function openChat(root: string, options: { sessionId?: string; focus?: boolean; label?: string } = {}): void {
  const herdr = new HerdrClient()
  const canonicalRoot = canonical(root)
  const workspace = primaryWorkspace(canonicalRoot, herdr)
  herdr.openPluginPane("dispatcher-chat", {
    cwd: canonicalRoot,
    workspaceId: workspace.workspaceId,
    placement: workspace.bootstrapPaneId ? "split" : "tab",
    ...(workspace.bootstrapPaneId ? { targetPane: workspace.bootstrapPaneId } : {}),
    focus: options.focus ?? true,
    env: {
      HERDR_PROJECT_ROOT: canonicalRoot,
      HERDR_CHAT_TAB_LABEL: options.label ?? CHAT_TITLE,
      ...(options.sessionId ? { HERDR_CHAT_SESSION_ID: options.sessionId } : {}),
    },
  })
  if (workspace.bootstrapPaneId) herdr.command(["pane", "close", workspace.bootstrapPaneId], false)
}

export function chatCurrent(): void {
  const root = currentProjectRoot()
  if (!root) {
    const context = pluginContext()
    const cwd = String(context.focused_pane_cwd ?? context.workspace_cwd ?? process.cwd())
    new HerdrClient().openPluginPane("dispatcher-picker", { cwd })
    return
  }
  openChat(root)
}

function discoverProjects(store = new StateStore(), projectsRoot = process.env.HERDR_PROJECTS_ROOT ?? resolve(homedir(), "Projects")): string[] {
  const roots = new Set(store.repositories())
  const visit = (directory: string): void => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || [".git", ".worktrees", "node_modules"].includes(entry.name)) continue
      const path = join(directory, entry.name)
      if (existsSync(join(path, ".git"))) {
        const root = primaryRepository(path)
        if (root) roots.add(root)
      } else {
        visit(path)
      }
    }
  }
  visit(projectsRoot)
  return [...roots].sort((a, b) => basename(a).localeCompare(basename(b)))
}

function fzf(rows: string, prompt: string): string | null {
  const result = run(["fzf", "--prompt", prompt, "--height", "100%", "--reverse"], { input: rows, check: false })
  if ([1, 130].includes(result.exitCode)) return null
  if (result.exitCode) throw new WorkflowError(result.stderr || "fzf failed")
  return result.stdout.trim()
}

export function openChatPicker(): void {
  const projects = discoverProjects()
  if (!projects.length) throw new WorkflowError("No Git repositories found")
  const selection = fzf(projects.map((root) => `${basename(root)}\t${root}`).join("\n"), "project> ")
  if (selection) openChat(selection.split("\t").at(-1)!)
}

export async function openChatHistory(): Promise<void> {
  const root = currentProjectRoot()
  if (!root) throw new WorkflowError("Chat history requires a pane inside a Git project")
  const sessions = await projectSessions(root)
  if (!sessions.length) throw new WorkflowError("No previous project chats found")
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const selection = fzf(sessions.map((session) => {
    const date = new Date(session.time.updated).toLocaleString()
    return `${session.title ?? "Untitled"}\t${date}\t${session.id}`
  }).join("\n"), "chat> ")
  if (!selection) return
  const selected = byId.get(selection.split("\t").at(-1)!)
  if (!selected) throw new WorkflowError("Chat picker returned an invalid session")
  const fork = await continueSession(selected.id, root)
  openChat(root, { sessionId: fork.id, label: selected.title ?? CHAT_TITLE })
}

export async function runChatPane(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const root = canonical(env.HERDR_PROJECT_ROOT ?? "")
  if (primaryRepository(root) !== root) throw new WorkflowError(`Invalid Project Chat repository: ${root}`)
  const opencode = openCodeCli(env)
  ensureCompanionInstalled(env)
  const identity = currentHerdrIdentity(env)
  const session = env.HERDR_CHAT_SESSION_ID
    ? { id: env.HERDR_CHAT_SESSION_ID }
    : await createSession(root, env.HERDR_CHAT_TAB_LABEL ?? CHAT_TITLE)
  const store = new StateStore()
  store.rememberRepository(root)
  store.registerChat({
    sessionId: session.id,
    projectRoot: root,
    ...identity,
    herdrBin: env.HERDR_BIN_PATH ?? "herdr",
    socketPath: env.HERDR_SOCKET_PATH ?? null,
  })
  const herdr = new HerdrClient()
  herdr.renameTab(identity.tabId, env.HERDR_CHAT_TAB_LABEL ?? CHAT_TITLE)
  const child = spawn(opencode, [root, "--session", session.id], { stdio: "inherit", env })
  const exit = new Promise<number>((resolvePromise, reject) => {
    child.once("error", (error) => reject(new WorkflowError(`Could not start opencode2: ${error.message}`)))
    child.once("close", (code) => resolvePromise(code ?? 1))
  })
  const exitCode = await exit
  if (exitCode !== 0) throw new WorkflowError(`opencode2 exited with status ${exitCode}`)
  return 0
}
