import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { WorkflowError } from "./errors.js"
import { primaryRepository } from "./git.js"
import { currentHerdrIdentity, HerdrClient, pluginContext } from "./herdr.js"
import { canonical, pluginRoot, stateDirectory } from "./paths.js"
import { ensureOpenCodeReady, openCodeCli } from "./opencode.js"
import { executable, run } from "./process.js"
import { StateStore } from "./state.js"

export function ensureCompanionInstalled(env: NodeJS.ProcessEnv = process.env): string {
  const source = resolve(pluginRoot(env), "dist/opencode-plugin.mjs")
  if (!existsSync(source)) throw new WorkflowError(`OpenCode companion bundle is missing: ${source}`)
  const configHome = resolve(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
  const autoPluginDirectory = resolve(configHome, "plugins")
  mkdirSync(autoPluginDirectory, { recursive: true })
  const destination = resolve(autoPluginDirectory, "wheels-dev-workflow.js")
  const obsoleteDestinations = [
    resolve(autoPluginDirectory, "wheels-dev-workflow.mjs"),
    resolve(configHome, "wheels-dev-workflow.js"),
    resolve(autoPluginDirectory, "tui/wheels-dev-workflow.js"),
  ]
  for (const path of obsoleteDestinations) {
    if (!lstatMaybe(path)) continue
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || readFileSync(path, "utf8").startsWith("// Managed by Wheels Dev Workflow")) {
      unlinkSync(path)
    } else {
      throw new WorkflowError(`Refusing to replace unmanaged OpenCode plugin: ${path}`)
    }
  }
  if (lstatMaybe(destination)) {
    const stat = lstatSync(destination)
    if (stat.isSymbolicLink()) unlinkSync(destination)
    else if (!readFileSync(destination, "utf8").startsWith("// Managed by Wheels Dev Workflow")) {
      throw new WorkflowError(`Refusing to replace unmanaged OpenCode plugin: ${destination}`)
    }
  }
  const herdrBin = executable(env.HERDR_BIN_PATH ?? "herdr", env)
  const sourceUrl = `${pathToFileURL(source).href}?mtime=${statSync(source).mtimeMs}`
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
`
  if (!existsSync(destination) || readFileSync(destination, "utf8") !== loader) writeFileSync(destination, loader)
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

function primaryWorkspace(root: string, herdr: HerdrClient): { workspaceId: string; replaceTabId?: string; bootstrapPaneId?: string } {
  for (const workspace of herdr.workspaces()) {
    const provenance = workspace.worktree as Record<string, unknown> | undefined
    if (provenance?.is_linked_worktree === false && provenance.checkout_path && canonical(String(provenance.checkout_path)) === root) {
      const tabId = String(workspace.active_tab_id ?? "")
      if (!tabId) throw new WorkflowError(`Primary workspace for ${root} has no active tab`)
      return { workspaceId: String(workspace.workspace_id), replaceTabId: tabId }
    }
  }
  const opened = herdr.openWorktree(root, root, basename(root))
  if (opened.alreadyOpen) {
    const pane = herdr.panes(opened.workspaceId).find((candidate) => String(candidate.pane_id) === opened.rootPaneId)
    const tabId = String(pane?.tab_id ?? "")
    if (!tabId) throw new WorkflowError(`Primary workspace for ${root} has no root tab`)
    return { workspaceId: opened.workspaceId, replaceTabId: tabId }
  }
  return { workspaceId: opened.workspaceId, bootstrapPaneId: opened.rootPaneId }
}

export async function openChat(root: string): Promise<void> {
  const canonicalRoot = canonical(root)
  const store = new StateStore()
  const hub = store.hub(canonicalRoot)
  if (hub) {
    const hubHerdr = new HerdrClient(hub.herdrBin, hub.socketPath ?? undefined)
    try {
      if (hubHerdr.tabs().some((tab) => String(tab.tab_id) === hub.tabId)) {
        hubHerdr.focusWorkspace(hub.workspaceId)
        store.close()
        return
      }
    } catch { /* stale Herdr session */ }
    store.deleteHub(canonicalRoot)
  }
  try {
    openCodeCli()
    await ensureOpenCodeReady()
    const herdr = new HerdrClient()
    const workspace = primaryWorkspace(canonicalRoot, herdr)
    herdr.openPluginPane("dispatcher-chat", {
      cwd: canonicalRoot,
      workspaceId: workspace.workspaceId,
      placement: workspace.bootstrapPaneId ? "split" : "tab",
      ...(workspace.bootstrapPaneId ? { targetPane: workspace.bootstrapPaneId } : {}),
      ...(workspace.bootstrapPaneId ? { direction: "down" as const } : {}),
      focus: true,
      env: { HERDR_PROJECT_ROOT: canonicalRoot },
    })
    await store.waitForHub(canonicalRoot)
    if (workspace.bootstrapPaneId) herdr.command(["pane", "close", workspace.bootstrapPaneId], false)
    if (workspace.replaceTabId) herdr.closeTab(workspace.replaceTabId)
  } finally {
    store.close()
  }
}

export async function chatCurrent(): Promise<void> {
  const root = currentProjectRoot()
  if (!root) {
    const context = pluginContext()
    const cwd = String(context.focused_pane_cwd ?? context.workspace_cwd ?? process.cwd())
    new HerdrClient().openPluginPane("dispatcher-picker", { cwd })
    return
  }
  await openChat(root)
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

export async function openChatPicker(): Promise<void> {
  const projects = discoverProjects()
  if (!projects.length) throw new WorkflowError("No Git repositories found")
  const selection = fzf(projects.map((root) => `${basename(root)}\t${root}`).join("\n"), "project> ")
  if (selection) await openChat(selection.split("\t").at(-1)!)
}

export async function runChatPane(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const root = canonical(env.HERDR_PROJECT_ROOT ?? "")
  if (primaryRepository(root) !== root) throw new WorkflowError(`Invalid Project Chat repository: ${root}`)
  const opencode = openCodeCli(env)
  ensureCompanionInstalled(env)
  await ensureOpenCodeReady(env)
  const identity = currentHerdrIdentity(env)
  const store = new StateStore()
  store.rememberRepository(root)
  const args = [root, "--standalone"]
  store.log("info", "project-chat.launch", JSON.stringify({ args, paneId: identity.paneId, tabId: identity.tabId }))
  const child = spawn(opencode, args, { stdio: "inherit", env: { ...env, HERDR_PROJECT_CHAT: "1" } })
  let exitCode: number | null = null
  let exitSignal: NodeJS.Signals | null = null
  const exit = new Promise<number>((resolvePromise, reject) => {
    child.once("error", (error) => reject(new WorkflowError(`Could not start opencode2: ${error.message}`)))
    child.once("close", (code, signal) => {
      exitCode = code
      exitSignal = signal
      resolvePromise(code ?? 1)
    })
  })
  try {
    await Promise.race([
      exit.then((code) => { throw new WorkflowError(`opencode2 exited during startup with status ${code}`) }),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)),
    ])
    store.registerHub({
      projectRoot: root,
      ...identity,
      herdrBin: env.HERDR_BIN_PATH ?? "herdr",
      socketPath: env.HERDR_SOCKET_PATH ?? null,
    })
    store.log("info", "project-chat.ready", JSON.stringify({ paneId: identity.paneId, tabId: identity.tabId }))
    const code = await exit
    if (code !== 0) throw new WorkflowError(`opencode2 exited with status ${code}${exitSignal ? ` (${exitSignal})` : ""}`)
    return 0
  } catch (error) {
    store.log("error", "project-chat.exit", JSON.stringify({ paneId: identity.paneId, exitCode, exitSignal, error: String(error) }))
    throw error
  } finally {
    store.deleteHub(root, identity.paneId)
    store.close()
  }
}
