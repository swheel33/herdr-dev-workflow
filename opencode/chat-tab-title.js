import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

function tabLabel(title) {
  const value = title.trim();
  if (value.length <= 48) return value;
  return `${value.slice(0, 45).trimEnd()}...`;
}

export const HerdrChatTabTitle = async () => {
  if (process.env.HERDR_DISPATCHER !== "1") return {};

  const tabID = process.env.HERDR_TAB_ID;
  const paneID = process.env.HERDR_PANE_ID;
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  if (!tabID) return {};

  let current = "";
  let reportedSession = "";
  return {
    event: async ({ event }) => {
      if (event?.type !== "session.created" && event?.type !== "session.updated") return;
      const info = event?.properties?.info;

      if (info?.id && !reportedSession) {
        try {
          if (paneID) {
            await run(herdr, [
              "pane", "report-agent-session", paneID,
              "--source", "herdr:opencode",
              "--agent", "opencode",
              "--agent-session-id", info.id,
            ]);
          }
          const threadID = process.env.HERDR_DISPATCH_THREAD_ID;
          const root = process.env.HERDR_DISPATCHER_PROJECT_ROOT;
          const pluginRoot = process.env.HERDR_PLUGIN_ROOT;
          if (threadID && root && pluginRoot) {
            await run("python3", [
              `${pluginRoot}/dispatcher.py`, "register-chat-session",
              "--thread-id", threadID,
              "--session-id", info.id,
              "--root", root,
            ]);
          }
          reportedSession = info.id;
        } catch {
          // Herdr also detects sessions; explicit reporting and history linking are best-effort.
        }
      }

      if (info?.parentID || !info?.title) return;

      const label = tabLabel(info.title);
      if (!label || label === current) return;
      try {
        await run(herdr, ["tab", "rename", tabID, label]);
        current = label;
      } catch {
        // The tab may already be closing; title synchronization is best-effort.
      }
    },
  };
};
