import { WorkflowError } from "./errors.js"
import { primaryRepository } from "./git.js"
import { HerdrClient } from "./herdr.js"
import { forkSession, getSession, prepareImplementationSession, promptSession, removeSession, renameSession } from "./opencode.js"
import { StateStore, type TargetKind } from "./state.js"
import { prepareTarget } from "./worktrees.js"

export interface DispatchRequest {
  request: string
  targetKind: TargetKind
  target: string
  sourceSessionId: string
  sourceMessageId: string
}

function handoff(checkout: string, request: string): string {
  return `Implement the requested change directly in ${checkout}.

Do not dispatch again or create another worktree. Preserve unrelated changes. Do not commit or push unless the request explicitly asks.

Request:
${request}`
}

export async function dispatchImplementation(request: DispatchRequest, store = new StateStore()): Promise<string> {
  const source = await getSession(request.sourceSessionId)
  const projectRoot = primaryRepository(source.location.directory)
  if (!projectRoot) throw new WorkflowError("This OpenCode session is not inside a Git repository")
  const hub = store.hub(projectRoot)
  if (!hub) throw new WorkflowError("This repository does not have a registered Herdr Project Chat hub")
  const text = request.request.trim()
  const target = request.target.trim()
  if (!text || !target) throw new WorkflowError("Dispatch request and target must not be empty")
  if (!store.beginDispatch({
    sourceSessionId: request.sourceSessionId,
    sourceMessageId: request.sourceMessageId,
    projectRoot,
    request: "",
    targetKind: request.targetKind,
    targetValue: target,
  })) {
    throw new WorkflowError("This dispatch turn has already been accepted; do not retry it")
  }

  const herdr = new HerdrClient(hub.herdrBin, hub.socketPath ?? undefined)
  let implementationSessionId: string | undefined
  let prepared: ReturnType<typeof prepareTarget> | undefined
  let promptStarted = false
  try {
    prepared = prepareTarget({
      repoRoot: projectRoot,
      target: { kind: request.targetKind, value: target },
      store,
      herdr,
    })
    store.updateDispatch(request.sourceSessionId, request.sourceMessageId, {
      status: "preparing",
      branch: prepared.branch,
      checkoutPath: prepared.checkoutPath,
    })
    const fork = await forkSession(request.sourceSessionId, request.sourceMessageId)
    implementationSessionId = fork.id
    store.updateDispatch(request.sourceSessionId, request.sourceMessageId, {
      status: "preparing",
      implementationSessionId: fork.id,
    })
    await prepareImplementationSession(fork.id, prepared.checkoutPath)
    await renameSession(fork.id, source.title?.trim() || prepared.branch)
    herdr.launchOpenCode(prepared.rootPaneId, prepared.checkoutPath, fork.id)
    await promptSession(fork.id, handoff(prepared.checkoutPath, text), () => { promptStarted = true })
    try {
      store.updateDispatch(request.sourceSessionId, request.sourceMessageId, {
        status: "delivered",
        implementationSessionId: fork.id,
      })
    } catch (error) {
      herdr.notify("Dispatch bookkeeping incomplete", `Implementation started, but its receipt could not be updated: ${error}. Do not redispatch.`)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (promptStarted) {
      try {
        store.updateDispatch(request.sourceSessionId, request.sourceMessageId, {
          status: "delivery_unknown",
          ...(implementationSessionId ? { implementationSessionId } : {}),
          error: detail,
        })
      } catch { /* the durable receipt still prevents redispatch */ }
      throw new WorkflowError(`OpenCode prompt delivery could not be confirmed. The implementation workspace was preserved; inspect it and do not redispatch. ${detail}`)
    }
    store.deleteDispatch(request.sourceSessionId, request.sourceMessageId)
    const location = prepared ? ` Artifacts were preserved at ${prepared.checkoutPath} on ${prepared.branch}.` : " Any artifacts created before the failure were preserved."
    throw new WorkflowError(`Dispatch stopped before implementation prompting.${location} ${detail}`)
  }

  try {
    herdr.openPluginPane("dispatcher-chat", {
      cwd: projectRoot,
      workspaceId: hub.workspaceId,
      placement: "tab",
      focus: false,
      env: { HERDR_PROJECT_ROOT: projectRoot },
    })
    await store.waitForHub(projectRoot, hub.paneId)
    herdr.closeTab(hub.tabId)
    await removeSession(request.sourceSessionId)
  } catch (error) {
    herdr.notify("Project Chat handoff incomplete", `Implementation started, but the dispatched Project Chat could not be replaced: ${error}`)
  }
  return `Implementation started in ${prepared!.branch} at ${prepared!.checkoutPath}. Do not dispatch this request again.`
}
