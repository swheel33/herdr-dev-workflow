import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parse } from "jsonc-parser"
import { describe, expect, it } from "vitest"
import { ensureCompanionInstalled } from "../src/chat.js"
import { openCodeCli } from "../src/opencode.js"
import { executable } from "../src/process.js"

describe("runtime integration", () => {
  it("finds executables directly from PATH without a login shell", () => {
    const root = mkdtempSync(resolve(tmpdir(), "wheels-path-"))
    const command = resolve(root, "path-only-command")
    writeFileSync(command, "#!/bin/sh\nexit 0\n")
    chmodSync(command, 0o755)
    expect(executable("path-only-command", { PATH: [root, "/usr/bin"].join(delimiter) })).toBe(command)
  })

  it("requires the pinned OpenCode preview before launching", () => {
    const root = mkdtempSync(resolve(tmpdir(), "wheels-opencode-path-"))
    const command = resolve(root, "opencode2")
    writeFileSync(command, '#!/bin/sh\nprintf "opencode2 v0.0.0-next-17189\\n"\n')
    chmodSync(command, 0o755)
    const env = { PATH: root }
    expect(openCodeCli(env)).toBe(command)
    writeFileSync(command, '#!/bin/sh\nprintf "opencode2 v0.0.0-next-99999\\n"\n')
    expect(() => openCodeCli(env)).toThrow("OpenCode CLI must be 0.0.0-next-17189")
  })

  it("removes the legacy loader entry while preserving JSONC plugins", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "wheels-companion-"))
    const pluginRoot = resolve(root, "plugin")
    const configRoot = resolve(root, "config")
    const pluginDirectory = resolve(configRoot, "opencode", "plugins")
    const herdr = resolve(root, "herdr")
    mkdirSync(resolve(pluginRoot, "dist"), { recursive: true })
    mkdirSync(pluginDirectory, { recursive: true })
    writeFileSync(herdr, `#!/bin/sh
printf '%s\n' '{"result":{"plugins":[{"plugin_id":"wheels.dev-workflow","enabled":true}]}}'
`)
    chmodSync(herdr, 0o755)
    writeFileSync(resolve(configRoot, "opencode", "package.json"), '{ "type": "module" }\n')
    writeFileSync(resolve(pluginRoot, "dist/opencode-plugin.mjs"), "export default { setup: async () => {} }\n")
    const legacy = resolve(pluginDirectory, "wheels-dev-workflow.mjs")
    writeFileSync(legacy, "// Managed by Wheels Dev Workflow\n")
    writeFileSync(resolve(configRoot, "opencode", "opencode.jsonc"), `{
  // Existing plugin must survive migration.
  "plugins": ["file:///existing.js", ${JSON.stringify(pathToFileURL(legacy).href)}]
}\n`)

    const destination = ensureCompanionInstalled({
      XDG_CONFIG_HOME: configRoot,
      HERDR_PLUGIN_ROOT: pluginRoot,
      HERDR_PLUGIN_STATE_DIR: resolve(root, "state"),
      HERDR_BIN_PATH: herdr,
    })
    const config = parse(readFileSync(resolve(configRoot, "opencode", "opencode.jsonc"), "utf8")) as { plugins: unknown[] }
    expect(config.plugins[0]).toBe("file:///existing.js")
    expect(config.plugins).toHaveLength(2)
    expect(readFileSync(destination, "utf8")).toContain("export default plugin")
    const loaded = await import(`${pathToFileURL(destination).href}?test=${Date.now()}`) as { default: { setup?: unknown } }
    expect(typeof loaded.default.setup).toBe("function")
  })

  it("refuses to overwrite a non-array plugins setting", () => {
    const root = mkdtempSync(resolve(tmpdir(), "wheels-config-"))
    const pluginRoot = resolve(root, "plugin")
    const configRoot = resolve(root, "config")
    mkdirSync(resolve(pluginRoot, "dist"), { recursive: true })
    mkdirSync(resolve(configRoot, "opencode"), { recursive: true })
    writeFileSync(resolve(pluginRoot, "dist/opencode-plugin.mjs"), "export default { setup: async () => {} }\n")
    writeFileSync(resolve(configRoot, "opencode", "opencode.jsonc"), '{ "plugins": "invalid" }\n')
    expect(() => ensureCompanionInstalled({
      XDG_CONFIG_HOME: configRoot,
      HERDR_PLUGIN_ROOT: pluginRoot,
      HERDR_PLUGIN_STATE_DIR: resolve(root, "state"),
    })).toThrow("plugins must be an array")
  })
})
