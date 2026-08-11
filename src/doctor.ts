import { executable, run } from "./process.js"
import { openCodeCli, openCodeVersion } from "./opencode.js"

export function doctor(): number {
  const nodeMajor = Number(process.versions.node.split(".")[0])
  const checks: Array<[string, boolean, boolean]> = [
    ["Node.js 24+", nodeMajor >= 24, true],
    ["herdr 0.8+", commandOk("herdr", "--version"), true],
    [`opencode2 preview (${openCodeLabel()})`, openCodeOk(), true],
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

function openCodeOk(): boolean {
  try { openCodeCli(); return true } catch { return false }
}

function openCodeLabel(): string {
  try { return openCodeVersion() } catch { return "unavailable" }
}
