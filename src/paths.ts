import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

export function canonical(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return canonical(env.HERDR_PLUGIN_STATE_DIR ?? resolve(homedir(), ".local/state/herdr-dev-workflow"))
}

export function pluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HERDR_PLUGIN_ROOT
  if (!configured || !isAbsolute(configured)) {
    throw new Error("HERDR_PLUGIN_ROOT must be an absolute path")
  }
  return canonical(configured)
}
