import { WorkflowError } from "./errors.js"
import { primaryRepository } from "./git.js"
import { currentHerdrIdentity, HerdrClient } from "./herdr.js"
import { forkSession, getSession, prepareImplementationSession, promptSession, renameSession } from "./opencode.js"
import { canonical } from "./paths.js"
import { StateStore, type ProjectHub, type TargetKind } from "./state.js"
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

export async function dispatchImplementation(request: DispatchRequest, store = new StateStore()): Promise<string> {
  const source = await getSession(request.sourceSessionId)
  const projectRoot = primaryRepository(source.location.directory)
  if (!projectRoot) throw new WorkflowError("This OpenCode session is not inside a Git repository")
  const hub = resolveHub(projectRoot, store)
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

  return `Implementation started in ${prepared!.branch} at ${prepared!.checkoutPath}. Do not dispatch this request again.`
}
