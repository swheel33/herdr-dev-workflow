import { spawn, spawnSync } from "node:child_process"
import { constants, existsSync, accessSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, isAbsolute, resolve } from "node:path"
import { CommandError } from "./errors.js"

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  check?: boolean
}

export function run(command: readonly string[], options: RunOptions = {}): CommandResult {
  const [executable, ...args] = command
  if (!executable) throw new Error("Command must not be empty")
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  })
  if (result.error) {
    throw new CommandError(command, null, result.stdout ?? "", result.stderr ?? "", `${executable}: ${result.error.message}`)
  }
  const output = {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
  if (options.check !== false && output.exitCode !== 0) {
    throw new CommandError(command, output.exitCode, output.stdout, output.stderr)
  }
  return output
}

export async function runAsync(command: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
  const [executable, ...args] = command
  if (!executable) throw new Error("Command must not be empty")
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8").on("data", (value: string) => { stdout += value })
    child.stderr?.setEncoding("utf8").on("data", (value: string) => { stderr += value })
    child.on("error", (error) => reject(new CommandError(command, null, stdout, stderr, `${executable}: ${error.message}`)))
    child.on("close", (exitCode) => {
      const result = { exitCode: exitCode ?? 1, stdout, stderr }
      if (options.check !== false && result.exitCode !== 0) {
        reject(new CommandError(command, result.exitCode, stdout, stderr))
      } else {
        resolvePromise(result)
      }
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function executable(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[`${name.toUpperCase()}_BIN`]
  const candidates = [
    override,
    isAbsolute(name) ? name : undefined,
    ...(!isAbsolute(name) ? (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => resolve(directory, name)) : []),
    resolve(homedir(), "Library/pnpm", name),
    resolve(homedir(), ".local/bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        accessSync(candidate, constants.X_OK)
        return candidate
      }
    } catch { /* try the next location */ }
  }
  throw new Error(`Executable not found: ${name}`)
}
