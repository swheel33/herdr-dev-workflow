import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { forkSession } from "../src/opencode.js"

const originalStateHome = process.env.XDG_STATE_HOME

afterEach(() => {
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalStateHome
})

describe("OpenCode fork boundary", () => {
  it("forks immediately before the active dispatch message", async () => {
    let received: unknown
    const server = createServer((request, response) => {
      if (request.url === "/api/health") {
        response.setHeader("content-type", "application/json")
        response.end('{"healthy":true}')
        return
      }
      const chunks: Buffer[] = []
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      request.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ data: {
          id: "forked",
          projectID: "project",
          location: { directory: "/tmp/repo" },
          time: { created: 1, updated: 1 },
        } }))
      })
    })
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing test server address")
    const stateHome = mkdtempSync(resolve(tmpdir(), "wheels-opencode-"))
    mkdirSync(resolve(stateHome, "opencode"))
    writeFileSync(resolve(stateHome, "opencode/service.json"), JSON.stringify({
      url: `http://127.0.0.1:${address.port}`,
      version: "0.0.0-next-17189",
    }))
    process.env.XDG_STATE_HOME = stateHome
    try {
      const fork = await forkSession("source", "dispatch-message")
      expect(fork.id).toBe("forked")
      expect(received).toEqual({ boundary: { type: "before", messageID: "dispatch-message" } })
    } finally {
      server.close()
    }
  })
})
