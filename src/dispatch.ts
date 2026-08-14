import { createHash, randomUUID } from "node:crypto"
import { WorkflowError } from "./errors.js"
import { primaryRepository } from "./git.js"
import { currentHerdrIdentity, HerdrClient } from "./herdr.js"
import { findForkedSession, forkSession, getSession, prepareImplementationSession, promptSession, renameSession, waitForSessionLocationReady } from "./opencode.js"
import { canonical } from "./paths.js"
import { dispatchTargetKey, StateStore, type DispatchRecord, type ProjectHub, type TargetKind } from "./state.js"
import { prepareTarget } from "./worktrees.js"

export interface DispatchRequest {
  request: string
  targetKind: TargetKind
  target: string
  sourceSessionId: string
  sourceMessageId: string
}

export interface DispatchStart {
  dispatch: DispatchRecord
  run: boolean
}

export interface ImplementationDelivery {
  sessionId: string
  directory: string
  title: string
  prompt: string
  onPromptAttempt: () => void
  onDelivered: () => void
  launch: () => void
}

export interface ImplementationDeliveryOperations {
  prepare: typeof prepareImplementationSession
  waitUntilReady: typeof waitForSessionLocationReady
  rename: typeof renameSession
  prompt: typeof promptSession
}

const deliveryOperations: ImplementationDeliveryOperations = {
  prepare: prepareImplementationSession,
  waitUntilReady: waitForSessionLocationReady,
  rename: renameSession,
  prompt: promptSession,
}

export async function deliverImplementation(
  input: ImplementationDelivery,
  operations: ImplementationDeliveryOperations = deliveryOperations,
): Promise<void> {
  await operations.prepare(input.sessionId, input.directory)
  await operations.waitUntilReady(input.sessionId, input.directory)
  await operations.rename(input.sessionId, input.title)
  await operations.prompt(input.sessionId, input.prompt, input.onPromptAttempt)
  input.onDelivered()
  input.launch()
}

export function dispatchFailureStatus(promptStarted: boolean): "delivery_unknown" | "pre_prompt_failed" {
  return promptStarted ? "delivery_unknown" : "pre_prompt_failed"
}

function requestHash(request: string): string {
  return createHash("sha256").update(request.trim()).digest("hex")
}

function handoff(checkout: string, request: string): string {
  return `Implement the requested change directly in ${checkout}.

Do not dispatch again or create another worktree. Preserve unrelated changes. Do not commit or push unless the request explicitly asks.

Request:
${request}`
}

function liveHub(hub: ProjectHub): boolean {
  const herdr = new HerdrClient(hub.herdrBin, hub.socketPath ?? undefined)
  try {
    return herdr.tabs().some((tab) => String(tab.tab_id) === hub.tabId)
      && herdr.panes(hub.workspaceId).some((pane) => String(pane.pane_id) === hub.paneId)
  } catch {
    return false
  }
}

function resolveHub(projectRoot: string, store: StateStore, env: NodeJS.ProcessEnv = process.env): ProjectHub {
  const registered = store.hub(projectRoot)
  if (registered && liveHub(registered)) return registered

  const environmentRoot = env.HERDR_PROJECT_ROOT
  if (environmentRoot && canonical(environmentRoot) === projectRoot) {
    try {
      const recovered = {
        projectRoot,
        ...currentHerdrIdentity(env),
        herdrBin: env.HERDR_BIN_PATH ?? "herdr",
        socketPath: env.HERDR_SOCKET_PATH ?? null,
      }
      if (liveHub(recovered)) {
        store.registerHub(recovered)
        return recovered
      }
    } catch { /* report the missing hub below */ }
  }

  if (registered) store.deleteHub(projectRoot, registered.paneId)
  throw new WorkflowError("This repository does not have a live Herdr Project Chat hub")
}

export function formatDispatch(dispatch: DispatchRecord): string {
  const lines = [
    `Dispatch ${dispatch.id} [${dispatch.status}]`,
    `  target: ${dispatch.branch ?? dispatch.targetValue}`,
    `  checkout: ${dispatch.checkoutPath ?? "pending"}`,
    `  implementation session: ${dispatch.implementationSessionId ?? "pending"}`,
  ]
  if (dispatch.error) lines.push(`  error: ${dispatch.error}`)
  if (dispatch.status === "preparing") lines.push("  recovery: preparation is running; inspect status instead of dispatching again")
  if (dispatch.status === "delivery_unknown") lines.push("  recovery: prompt delivery may have succeeded; resume the implementation session and do not redispatch")
  if (dispatch.status === "pre_prompt_failed") lines.push("  recovery: retrying this target resumes this durable dispatch and preserves its artifacts")
  return lines.join("\n")
}

export function dispatchReport(store: StateStore, projectRoot?: string): string {
  const dispatches = store.dispatches(projectRoot)
  if (!dispatches.length) return "No implementation dispatches recorded."
  return dispatches.map(formatDispatch).join("\n\n")
}

export async function startDispatch(request: DispatchRequest, store = new StateStore()): Promise<DispatchStart> {
  const source = await getSession(request.sourceSessionId)
  const projectRoot = primaryRepository(source.location.directory)
  if (!projectRoot) throw new WorkflowError("This OpenCode session is not inside a Git repository")
  const text = request.request.trim()
  const target = request.target.trim()
  if (!text || !target) throw new WorkflowError("Dispatch request and target must not be empty")

  const result = store.beginDispatch({
    id: `dispatch-${randomUUID()}`,
    sourceSessionId: request.sourceSessionId,
    sourceMessageId: request.sourceMessageId,
    projectRoot,
    request: "",
    targetKind: request.targetKind,
    targetValue: target,
    targetKey: dispatchTargetKey(request.targetKind, target),
    requestHash: requestHash(text),
  })
  if (result.created) return { dispatch: result.dispatch, run: true }
  const hash = requestHash(text)
  if (result.dispatch.status === "preparing" && result.dispatch.requestHash === null) {
    store.adoptDispatchRequest(result.dispatch.id, hash)
    result.dispatch = store.dispatch(result.dispatch.id)!
  }
  const sameRequest = result.dispatch.requestHash === hash
  if (sameRequest && result.dispatch.status === "pre_prompt_failed" && store.resumeDispatch(result.dispatch.id, hash)) {
    return { dispatch: store.dispatch(result.dispatch.id)!, run: true }
  }
  return { dispatch: result.dispatch, run: sameRequest && result.dispatch.status === "preparing" }
}

export async function runDispatch(dispatchId: string, request: string, store = new StateStore()): Promise<void> {
  let dispatch = store.dispatch(dispatchId)
  if (!dispatch) throw new WorkflowError(`Unknown dispatch: ${dispatchId}`)
  if (dispatch.status !== "preparing") return
  if (dispatch.requestHash !== requestHash(request)) return
  if (!store.claimDispatchRun(dispatchId, process.pid)) return
  dispatch = store.dispatch(dispatchId)!

  let herdr: HerdrClient | undefined
  let promptStarted = false
  try {
    const hub = resolveHub(dispatch.projectRoot, store)
    const activeHerdr = new HerdrClient(hub.herdrBin, hub.socketPath ?? undefined)
    herdr = activeHerdr
    const prepared = prepareTarget({
      repoRoot: dispatch.projectRoot,
      target: { kind: dispatch.targetKind, value: dispatch.targetValue },
      store,
      herdr: activeHerdr,
      ...(dispatch.branch && dispatch.checkoutPath ? {
        resume: { branch: dispatch.branch, checkoutPath: dispatch.checkoutPath },
      } : {}),
      onResolved: ({ branch, checkoutPath }) => {
        store.updateDispatch(dispatchId, { status: "preparing", branch, checkoutPath })
        dispatch = store.dispatch(dispatchId)!
      },
      onProvisioned: ({ branch, checkoutPath }) => {
        store.updateDispatch(dispatchId, { status: "preparing", branch, checkoutPath })
        dispatch = store.dispatch(dispatchId)!
      },
    })
    if (!store.claimDispatchTarget(dispatchId, dispatch.projectRoot, `branch:${prepared.branch}`)) {
      throw new WorkflowError(`Another dispatch already owns target branch ${prepared.branch}`)
    }

    const source = await getSession(dispatch.sourceSessionId)
    let implementationSessionId = dispatch.implementationSessionId
    if (!implementationSessionId) {
      implementationSessionId = (await findForkedSession(dispatch.sourceSessionId, dispatch.sourceMessageId, dispatch.createdAt)
        ?? await forkSession(dispatch.sourceSessionId, dispatch.sourceMessageId)).id
      store.updateDispatch(dispatchId, { status: "preparing", implementationSessionId })
    }
    await deliverImplementation({
      sessionId: implementationSessionId,
      directory: prepared.checkoutPath,
      title: source.title?.trim() || prepared.branch,
      prompt: handoff(prepared.checkoutPath, request.trim()),
      onPromptAttempt: () => {
        store.updateDispatch(dispatchId, { status: "delivery_unknown", implementationSessionId })
        promptStarted = true
      },
      onDelivered: () => store.updateDispatch(dispatchId, { status: "delivered", implementationSessionId }),
      launch: () => {
        try {
          activeHerdr.launchOpenCode(prepared.rootPaneId, prepared.checkoutPath, implementationSessionId)
        } catch (error) {
          activeHerdr.notify("Implementation delivered without opening its pane", `${formatDispatch(store.dispatch(dispatchId)!)}\n${String(error)}`)
        }
      },
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    store.updateDispatch(dispatchId, {
      status: dispatchFailureStatus(promptStarted),
      error: detail,
    })
    herdr?.notify(
      promptStarted ? "Implementation delivery is unknown" : "Implementation dispatch paused before prompting",
      formatDispatch(store.dispatch(dispatchId)!),
    )
  }
}

export async function dispatchStatus(sourceSessionId: string, store = new StateStore()): Promise<string> {
  const source = await getSession(sourceSessionId)
  const projectRoot = primaryRepository(source.location.directory)
  if (!projectRoot) throw new WorkflowError("This OpenCode session is not inside a Git repository")
  return dispatchReport(store, projectRoot)
}
