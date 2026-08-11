import { build } from "esbuild"
import { rm } from "node:fs/promises"

await rm("dist", { recursive: true, force: true })

await build({
  entryPoints: {
    cli: "src/cli.ts",
    "opencode-plugin": "src/opencode-plugin.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  mainFields: ["module", "main"],
  sourcemap: false,
  packages: "bundle",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
})
