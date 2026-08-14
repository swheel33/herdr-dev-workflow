import { build } from "esbuild"
import { readdir, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const output = resolve(".test-dist")
await rm(output, { recursive: true, force: true })
const entryPoints = (await readdir("tests"))
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => resolve("tests", file))

await build({
  entryPoints,
  outdir: output,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
})

const tests = (await readdir(output))
  .filter((file) => file.endsWith(".js"))
  .map((file) => resolve(output, file))
const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" })
await rm(output, { recursive: true, force: true })
process.exitCode = result.status ?? 1
