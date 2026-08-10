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
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  if (!tabID) return {};

  let current = "";
  return {
    event: async ({ event }) => {
      if (event?.type !== "session.created" && event?.type !== "session.updated") return;
      const info = event?.properties?.info;
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
