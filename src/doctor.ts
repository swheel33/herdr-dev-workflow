import { executable, run } from "./process.js"

export function doctor(): number {
  const nodeMajor = Number(process.versions.node.split(".")[0])
  const checks: Array<[string, boolean, boolean]> = [
    ["Node.js 24+", nodeMajor >= 24, true],
    ["herdr 0.8+", commandOk("herdr", "--version"), true],
    ["opencode2 preview 17189", opencodeCompatible(commandOutput("opencode2", "--version")), true],
    ["git", commandOk("git", "--version"), true],
    ["fzf", commandOk("fzf", "--version"), true],
    ["gh", commandOk("gh", "--version"), false],
    ["pnpm", commandOk("pnpm", "--version"), true],
    ["nvim", commandOk("nvim", "--version"), false],
    ["lazygit", commandOk("lazygit", "--version"), false],
  ]
  console.log("Wheels Dev Workflow dependency check\n")
  for (const [name, ok, required] of checks) console.log(`${ok ? "ok" : required ? "missing" : "optional"}  ${name}`)
  return checks.some(([, ok, required]) => required && !ok) ? 1 : 0
}

function commandOk(command: string, argument: string): boolean {
  try { return run([executable(command), argument], { check: false }).exitCode === 0 } catch { return false }
}

function commandOutput(command: string, argument: string): string {
  try {
    const result = run([executable(command), argument], { check: false })
    return result.exitCode === 0 ? result.stdout.trim() : ""
  } catch {
    return ""
  }
}

function opencodeCompatible(version: string): boolean {
  const build = version.match(/0\.0\.0-next-(\d+)/)?.[1]
  return build === "17189"
}
