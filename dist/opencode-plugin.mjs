#!/usr/bin/env node

// src/opencode-plugin.ts
import { spawn } from "node:child_process";
import { resolve } from "node:path";
var SYSTEM = `You are Project Chat for the current repository. Discuss requirements, inspect code, review, and plan without changing files or running shell commands.

When the user asks to implement work, call dispatch_implementation exactly once. Use targetKind "new" with a short slug for new work, "branch" for an existing local or origin branch, or "pr" for a pull request number or URL. Include the complete implementation request. Do not reproduce Git or Herdr steps manually.`;
function executeDispatch(options, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [resolve(options.pluginRoot, "dist/cli.mjs"), "dispatch-tool"], {
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
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `Dispatch process exited ${code}`));
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
      for (const current of agents.list()) {
        if (current.mode !== "subagent") agents.update(String(current.id), (agent) => {
          agent.hidden = true;
        });
      }
      agents.update("project-chat", (agent) => {
        agent.description = "Discussion-only project coordination and implementation dispatch";
        agent.system = SYSTEM;
        agent.mode = "primary";
        agent.hidden = false;
        agent.color = "#D27E99";
        agent.permissions.push(
          { action: "edit", resource: "*", effect: "deny" },
          { action: "shell", resource: "*", effect: "deny" },
          { action: "subagent", resource: "*", effect: "deny" },
          { action: "dispatch_implementation", resource: "*", effect: "allow" }
        );
      });
      agents.default("project-chat");
    });
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "dispatch_implementation",
        description: "Dispatch an implementation agent into a new task worktree, existing branch, or pull request branch.",
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
          content: await executeDispatch(options, {
            ...input,
            sourceSessionId: String(context.sessionID),
            sourceMessageId: String(context.messageID)
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
