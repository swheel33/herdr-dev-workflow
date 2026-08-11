import { scanMerged, watchMerged } from "./auto-prune.js"
import { readSync } from "node:fs"
import { chatCurrent, ensureCompanionInstalled, openChatPicker, runChatPane } from "./chat.js"
import { cleanupReport, handleCleanupEvent, retryCleanup } from "./cleanup.js"
import { doctor } from "./doctor.js"
import { dispatchImplementation } from "./dispatch.js"
import { WorkflowError } from "./errors.js"
import { HerdrClient, pluginContext } from "./herdr.js"
import { interactiveBlankProject } from "./projects.js"
import { ensureProjectChatCapability } from "./opencode.js"
import { StateStore } from "./state.js"

async function main(args = process.argv.slice(2)): Promise<number> {
  const command = args[0]
  const store = new StateStore()
  if (command === "startup") {
    ensureCompanionInstalled()
    await ensureProjectChatCapability()
    return retryCleanup(store)
  }
  if (command === "event") return handleCleanupEvent(store)
  if (command === "retry-cleanup") return retryCleanup(store)
  if (command === "show-cleanup") { console.log(cleanupReport(store)); return store.cleanupJobs().length ? 1 : 0 }
  if (command === "workflow-status") {
    const dependencyStatus = doctor()
    const cleanupFailures = retryCleanup(store)
    console.log(`\nCleanup\n\n${cleanupReport(store)}`)
    const activity = store.recentLogs(100)
      .filter((entry) => entry.kind.startsWith("auto-prune.") || entry.kind.startsWith("cleanup."))
      .slice(0, 20)
      .reverse()
    console.log("\nRecent pruning and cleanup activity\n")
    if (!activity.length) console.log("No pruning or cleanup activity recorded yet.")
    for (const entry of activity) {
      console.log(`${new Date(entry.createdAt).toISOString()} ${entry.level} ${entry.kind}: ${entry.message}`)
    }
    return dependencyStatus || cleanupFailures ? 1 : 0
  }
  if (command === "scan-merged") { console.log(JSON.stringify(scanMerged(store))); return 0 }
  if (command === "watch-merged") { await watchMerged(store); return 0 }
  if (command === "chat-current") { await chatCurrent(); return 0 }
  if (command === "chat-picker") { await openChatPicker(); return 0 }
  if (command === "run-chat") return await runChatPane()
  if (command === "dispatch-tool") {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Parameters<typeof dispatchImplementation>[0]
    console.log(await dispatchImplementation(input, store))
    return 0
  }
  if (command === "blank-project") return interactiveBlankProject()
  if (command === "doctor") return doctor()
  if (command === "logs") {
    for (const entry of store.recentLogs()) console.log(`${new Date(entry.createdAt).toISOString()} ${entry.level} ${entry.kind}: ${entry.message}`)
    return 0
  }
  if (command === "open-pane") {
    const entrypoint = args[1]
    if (!entrypoint) throw new WorkflowError("Missing pane entrypoint")
    const context = pluginContext()
    const cwd = String(context.focused_pane_cwd ?? context.workspace_cwd ?? process.cwd())
    new HerdrClient().openPluginPane(entrypoint, { cwd })
    return 0
  }
  throw new WorkflowError(`Unknown command: ${command ?? "(missing)"}`)
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  const message = error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ""}` : String(error)
  console.error(message)
  try { new StateStore().log("error", `cli.${process.argv[2] ?? "unknown"}`, message) } catch { /* stderr remains authoritative */ }
  if (process.argv[2] === "run-chat" && process.stdin.isTTY) {
    process.stderr.write("\nPress enter to close...")
    try { readSync(0, Buffer.alloc(1), 0, 1, null) } catch { /* pane is already closing */ }
  }
  process.exitCode = 1
})
