import { existsSync, lstatSync, mkdirSync, readSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { WorkflowError } from "./errors.js"
import { openChat } from "./chat.js"
import { canonical } from "./paths.js"
import { run } from "./process.js"
import { StateStore } from "./state.js"

function prompt(label: string, fallback?: string): string {
  process.stdout.write(`${label}${fallback ? ` [${fallback}]` : ""}: `)
  const buffer = Buffer.alloc(4096)
  const count = readSync(0, buffer, 0, buffer.length, null)
  const value = buffer.subarray(0, count).toString("utf8").trim()
  return value || fallback || ""
}

export function normalizeProjectName(value: string): string {
  const name = value.trim()
  if (!name || name === "." || name === "..") throw new WorkflowError("Project name must be one non-empty directory name")
  if (/[\\/\0\x00-\x1f\x7f]/.test(name)) throw new WorkflowError("Project name cannot contain separators or control characters")
  return name
}

export function createBlankProject(input: {
  name: string
  parent: string
  github?: boolean
  visibility?: "private" | "public"
}, store = new StateStore()): { destination: string; githubError?: string } {
  const name = normalizeProjectName(input.name)
  const parent = canonical(input.parent)
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) throw new WorkflowError(`Parent directory does not exist: ${parent}`)
  const destination = resolve(parent, name)
  if (existsSync(destination)) {
    if (lstatSync(destination).isSymbolicLink()) throw new WorkflowError(`Project destination must not be a symlink: ${destination}`)
    if (readdirSync(destination).length) throw new WorkflowError(`Project destination is not empty: ${destination}`)
  } else {
    mkdirSync(destination)
  }
  run(["git", "init", "-b", "main", destination])
  run(["git", "-C", destination, "commit", "--allow-empty", "-m", "Initial commit"])
  let githubError: string | undefined
  if (input.github) {
    try {
      run(["gh", "auth", "status"])
      run(["gh", "repo", "create", name, `--${input.visibility ?? "private"}`, "--source", ".", "--remote", "origin"], { cwd: destination })
      run(["git", "push", "-u", "origin", "main"], { cwd: destination })
    } catch (error) {
      githubError = error instanceof Error ? error.message : String(error)
    }
  }
  store.rememberRepository(destination)
  openChat(destination)
  return githubError ? { destination, githubError } : { destination }
}

export function interactiveBlankProject(): number {
  const name = prompt("Project name")
  if (!name) return 0
  const parent = prompt("Parent directory", resolve(homedir(), "Projects"))
  const github = /^y(es)?$/i.test(prompt("Create GitHub repository (yes/no)", "no"))
  const visibility = github && /^pub/i.test(prompt("GitHub visibility (private/public)", "private")) ? "public" : "private"
  const result = createBlankProject({ name, parent, github, visibility })
  console.log(`Created local repository: ${result.destination}`)
  if (result.githubError) {
    console.error(`GitHub setup failed; local project was kept and opened.\n${result.githubError}`)
    return 1
  }
  return 0
}
