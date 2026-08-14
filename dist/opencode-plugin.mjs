#!/usr/bin/env node

// src/opencode-plugin.ts
import { spawn } from "node:child_process";
import { resolve } from "node:path";
var SYSTEM = `You are Project Chat for the current repository. Discuss requirements, inspect code, review, and plan without changing project files or mutating local or remote project state. Use CLI commands and configured MCP tools when they provide relevant authenticated project context.

When asked to review a GitHub pull request, use the authenticated GitHub CLI to retrieve the requested PR whenever possible. Inspect its metadata, diff, checks, reviews, general conversation comments, and inline review comments, using gh api when needed. Inline comments such as Greptile findings are not completely represented by gh pr view --comments alone.

Always state the access basis for PR work accurately: "GitHub-fetched PR" only after successfully retrieving the requested PR through GitHub; "local refs only" when inspecting repository refs without retrieving the PR; or "unable to access requested PR" when neither source is available. Report authentication, authorization, network, repository, and partial-data limitations explicitly. Never imply that you reviewed a PR, its comments, or its current state when you did not retrieve that data.

When the user asks to implement work, call dispatch_implementation exactly once. Use targetKind "new" with a short slug for new work, "branch" for an existing local or origin branch, or "pr" for a pull request number or URL. Include the complete implementation request. Do not reproduce Git or Herdr steps manually.

Dispatch returns a durable dispatch ID immediately while preparation continues in the background. If a tool call is interrupted or its result is unclear, call implementation_dispatch_status. Never redispatch merely because a tool response was interrupted; status exposes the implementation session ID and recovery guidance.`;
function executeCli(options, command, input) {
  return new Promise((resolvePromise) => {
    const child = spawn("node", [resolve(options.pluginRoot, "dist/cli.mjs"), command], {
      env: { ...process.env, HERDR_PLUGIN_ROOT: options.pluginRoot, HERDR_PLUGIN_STATE_DIR: options.stateDir },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value) => {
      stdout += value;
    });
    child.stderr.setEncoding("utf8").on("data", (value) => {
      stderr += value;
    });
    child.on("error", (error) => resolvePromise(`Workflow command was interrupted before returning a receipt: ${error.message}`));
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else resolvePromise(`Dispatch did not return a receipt. Inspect implementation_dispatch_status before retrying. ${stderr.trim() || stdout.trim() || `Process exited ${code}`}`);
    });
    child.stdin.end(JSON.stringify(input));
  });
}
var plugin = {
  id: "wheels.dev-workflow",
  setup: async (ctx) => {
    if (process.env.HERDR_PROJECT_CHAT !== "1") return;
    const raw = ctx.options;
    const options = {
      pluginRoot: typeof raw.pluginRoot === "string" ? raw.pluginRoot : "",
      stateDir: typeof raw.stateDir === "string" ? raw.stateDir : ""
    };
    if (!options.pluginRoot || !options.stateDir) throw new Error("Wheels pluginRoot and stateDir options are required");
    await ctx.agent.transform((agents) => {
      const planPermissions = agents.get("plan")?.permissions;
      if (!planPermissions) throw new Error("OpenCode plan agent is required for Project Chat");
      for (const current of agents.list()) {
        if (current.mode !== "subagent") agents.update(String(current.id), (agent) => {
          agent.hidden = true;
        });
      }
      agents.update("project-chat", (agent) => {
        agent.description = "Read-only project coordination, authenticated inspection, and implementation dispatch";
        agent.system = SYSTEM;
        agent.mode = "primary";
        agent.hidden = false;
        agent.color = "#D27E99";
        agent.permissions = planPermissions.map((permission) => ({ ...permission }));
        agent.permissions.push(
          { action: "dispatch_implementation", resource: "*", effect: "allow" },
          { action: "implementation_dispatch_status", resource: "*", effect: "allow" }
        );
      });
      agents.default("project-chat");
    });
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "dispatch_implementation",
        description: "Start or recover a durable implementation dispatch. Returns its durable ID and current status without waiting for implementation preparation.",
        input: {
          type: "object",
          properties: {
            request: { type: "string", minLength: 1 },
            targetKind: { type: "string", enum: ["new", "branch", "pr"] },
            target: { type: "string", minLength: 1 }
          },
          required: ["request", "targetKind", "target"],
          additionalProperties: false
        },
        options: { codemode: false },
        execute: async (input, context) => ({
          content: await executeCli(options, "dispatch-tool", {
            ...input,
            sourceSessionId: String(context.sessionID),
            sourceMessageId: String(context.messageID)
          })
        })
      });
      tools.add({
        name: "implementation_dispatch_status",
        description: "Read durable implementation dispatch status, recovery guidance, workspace paths, and implementation session IDs for this repository.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: false },
        execute: async (_input, context) => ({
          content: await executeCli(options, "dispatch-status-tool", {
            sourceSessionId: String(context.sessionID)
          })
        })
      });
    });
  }
};
var opencode_plugin_default = plugin;
export {
  opencode_plugin_default as default
};
