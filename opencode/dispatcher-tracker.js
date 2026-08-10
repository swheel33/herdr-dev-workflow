import fs from "node:fs";
import path from "node:path";

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export const HerdrDispatcherTracker = async () => {
  if (process.env.HERDR_DISPATCHER !== "1") return {};

  const stateRoot = process.env.HERDR_PLUGIN_STATE_DIR;
  const projectRoot = process.env.HERDR_DISPATCHER_PROJECT_ROOT;
  const instanceID = process.env.HERDR_DISPATCHER_INSTANCE_ID;
  if (!stateRoot || !projectRoot || !instanceID) return {};

  return {
    event: async ({ event }) => {
      if (event?.type !== "session.created" && event?.type !== "session.updated") return;
      const info = event?.properties?.info;
      const sessionID = event?.properties?.sessionID || info?.id;
      if (!sessionID || info?.parentID) return;

      const now = Date.now();
      writeJson(path.join(stateRoot, "dispatcher-instances", `${instanceID}.json`), {
        session_id: sessionID,
        project_root: projectRoot,
        updated_at: now,
      });

      const discussionPath = path.join(stateRoot, "discussion-sessions", `${sessionID}.json`);
      writeJson(discussionPath, {
        session_id: sessionID,
        project_root: projectRoot,
        title: info?.title,
        updated_at: now,
      });
    },
  };
};
