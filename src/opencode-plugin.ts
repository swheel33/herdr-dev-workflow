import { spawn } from "node:child_process"
import { resolve } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

const SYSTEM = `You are Project Chat for the current repository. Discuss requirements, inspect code, review, and plan without changing project files or mutating local or remote project state. Use CLI commands and configured MCP tools when they provide relevant authenticated project context.

When asked to review a GitHub pull request, use the authenticated GitHub CLI to retrieve the requested PR whenever possible. Inspect its metadata, diff, checks, reviews, general conversation comments, and inline review comments, using gh api when needed. Inline comments such as Greptile findings are not completely represented by gh pr view --comments alone.

Always state the access basis for PR work accurately: "GitHub-fetched PR" only after successfully retrieving the requested PR through GitHub; "local refs only" when inspecting repository refs without retrieving the PR; or "unable to access requested PR" when neither source is available. Report authentication, authorization, network, repository, and partial-data limitations explicitly. Never imply that you reviewed a PR, its comments, or its current state when you did not retrieve that data.

When the user asks to implement work, call dispatch_implementation exactly once. Use targetKind "new" with a short slug for new work, "branch" for an existing local or origin branch, or "pr" for a pull request number or URL. Include the complete implementation request. Do not reproduce Git or Herdr steps manually.`

function executeDispatch(options: { pluginRoot: string; stateDir: string }, input: unknown): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn("node", [resolve(options.pluginRoot, "dist/cli.mjs"), "dispatch-tool"], {
      env: { ...process.env, HERDR_PLUGIN_ROOT: options.pluginRoot, HERDR_PLUGIN_STATE_DIR: options.stateDir },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value })
    child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value })
    child.on("error", (error) => resolvePromise(`Dispatch failed: ${error.message}`))
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim())
      else resolvePromise(`Dispatch failed: ${stderr.trim() || stdout.trim() || `Dispatch process exited ${code}`}`)
    })
    child.stdin.end(JSON.stringify(input))
  })
}

const plugin: Plugin.Plugin = {
  id: "wheels.dev-workflow",
  setup: async (ctx) => {
    if (process.env.HERDR_PROJECT_CHAT !== "1") return

    const raw = ctx.options as Record<string, unknown>
    const options = {
      pluginRoot: typeof raw.pluginRoot === "string" ? raw.pluginRoot : "",
      stateDir: typeof raw.stateDir === "string" ? raw.stateDir : "",
    }
    if (!options.pluginRoot || !options.stateDir) throw new Error("Wheels pluginRoot and stateDir options are required")
    await ctx.agent.transform((agents) => {
      const planPermissions = agents.get("plan")?.permissions
      if (!planPermissions) throw new Error("OpenCode plan agent is required for Project Chat")
      for (const current of agents.list()) {
        if (current.mode !== "subagent") agents.update(String(current.id), (agent) => { agent.hidden = true })
      }
      agents.update("project-chat", (agent) => {
        agent.description = "Read-only project coordination, authenticated inspection, and implementation dispatch"
        agent.system = SYSTEM
        agent.mode = "primary"
        agent.hidden = false
        agent.color = "#D27E99"
        agent.permissions = planPermissions.map((permission) => ({ ...permission }))
        agent.permissions.push(
          { action: "dispatch_implementation", resource: "*", effect: "allow" },
        )
      })
      agents.default("project-chat")
    })
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "dispatch_implementation",
        description: "Dispatch an implementation agent into a new task worktree, existing branch, or pull request branch.",
        input: {
          type: "object",
          properties: {
            request: { type: "string", minLength: 1 },
            targetKind: { type: "string", enum: ["new", "branch", "pr"] },
            target: { type: "string", minLength: 1 },
          },
          required: ["request", "targetKind", "target"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => ({
          content: await executeDispatch(options, {
            ...input as Record<string, unknown>,
            sourceSessionId: String(context.sessionID),
            sourceMessageId: String(context.messageID),
          }),
        }),
      })
    })
  },
}

export default plugin
