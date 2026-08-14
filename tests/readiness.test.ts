import assert from "node:assert/strict"
import test from "node:test"
import { deliverImplementation, dispatchFailureStatus } from "../src/dispatch.js"
import { waitForSessionLocationReady } from "../src/opencode.js"

const directory = "/tmp/opencode-ready-worktree"
const sessionId = "ses_test"

function session() {
  return {
    data: {
      id: sessionId,
      projectID: "project",
      location: { directory },
      time: { created: 1, updated: 1 },
    },
  }
}

function location() {
  return {
    directory,
    project: { id: "project", directory, canonical: "/tmp/project" },
  }
}

test("readiness retries until destination catalogs are available", async () => {
  let now = 0
  let attempts = 0
  const calls: string[] = []

  await waitForSessionLocationReady(sessionId, directory, {
    timeoutMs: 1_000,
    intervalMs: 100,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds },
    request: async (path) => {
      calls.push(path)
      if (path.startsWith("/api/session/")) {
        attempts += 1
        return session()
      }
      if (path.startsWith("/api/location?")) return location()
      if (path.startsWith("/api/model?")) {
        if (attempts === 1) throw new Error("model catalog unavailable (503)")
        return { location: location(), data: [] }
      }
      if (path.startsWith("/api/agent?")) return { location: location(), data: [{ id: "build" }] }
      throw new Error(`Unexpected request: ${path}`)
    },
  })

  assert.equal(attempts, 2)
  assert.deepEqual(calls.map((path) => path.split("?")[0]), [
    `/api/session/${sessionId}`,
    "/api/location",
    "/api/model",
    `/api/session/${sessionId}`,
    "/api/location",
    "/api/model",
    "/api/agent",
  ])
})

test("readiness times out before prompt admission with a useful error", async () => {
  let now = 0
  await assert.rejects(
    waitForSessionLocationReady(sessionId, directory, {
      timeoutMs: 300,
      intervalMs: 100,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
      request: async () => { throw new Error("location unavailable") },
    }),
    /did not become ready within 300ms.*location unavailable/,
  )
  assert.equal(dispatchFailureStatus(false), "pre_prompt_failed")
  assert.equal(dispatchFailureStatus(true), "delivery_unknown")
})

test("delivery waits for readiness before prompt, completion, and launch", async () => {
  const order: string[] = []
  await deliverImplementation({
    sessionId,
    directory,
    title: "title",
    prompt: "prompt",
    onPromptAttempt: () => order.push("prompt-attempt"),
    onDelivered: () => order.push("delivered"),
    launch: () => order.push("launch"),
  }, {
    prepare: async () => { order.push("prepare") },
    waitUntilReady: async () => { order.push("ready") },
    rename: async () => { order.push("rename") },
    prompt: async (_id, _text, onAttempt) => {
      order.push("prompt")
      onAttempt?.()
    },
  })

  assert.deepEqual(order, ["prepare", "ready", "rename", "prompt", "prompt-attempt", "delivered", "launch"])
})

test("readiness failure does not admit a prompt or launch a pane", async () => {
  const order: string[] = []
  await assert.rejects(deliverImplementation({
    sessionId,
    directory,
    title: "title",
    prompt: "prompt",
    onPromptAttempt: () => order.push("prompt-attempt"),
    onDelivered: () => order.push("delivered"),
    launch: () => order.push("launch"),
  }, {
    prepare: async () => { order.push("prepare") },
    waitUntilReady: async () => {
      order.push("ready")
      throw new Error("readiness timeout")
    },
    rename: async () => { order.push("rename") },
    prompt: async () => { order.push("prompt") },
  }), /readiness timeout/)

  assert.deepEqual(order, ["prepare", "ready"])
})
