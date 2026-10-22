import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTools, prompt, setup, state } from "./test-fixtures.ts";

async function waitForVmStart() {
  for (let attempt = 0; attempt < 20 && state.starts === 0; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(state.starts, 1);
}

test("user bash starts VM lazily rather than falling through to host", async () => {
  const h = await setup();
  assert.ok((await h.emit("user_bash"))?.operations);
  assert.equal(state.starts, 1);
  await h.emit("session_shutdown");
});

test("mounts session CWD at same guest path and keeps VM prompt marker", async () => {
  const h = await setup();
  const cwd = process.cwd();
  await h.emit("session_start");

  const mounts = state.vmOptions[0]?.vfs?.mounts;
  assert.deepEqual(Object.keys(mounts ?? {}), [cwd]);

  const result = await h.emit("before_agent_start", {
    systemPrompt: `Current working directory: ${cwd}`,
  });
  assert.equal(
    result?.systemPrompt,
    `Current working directory: ${cwd} (Gondolin VM, mounted from host: ${cwd})`,
  );
  await h.emit("session_shutdown");
});

test("failed startup stays sandboxed, supports off, and retries safely", async () => {
  const h = await setup();
  state.failStart = true;
  await assert.rejects(h.emit("session_start"), /VM unavailable/);
  await assert.rejects(h.emit("user_bash"), /VM unavailable/);
  const read = h.tools.get("read");
  assert.ok(read);
  await assert.rejects(
    read.execute("id", {}, undefined, undefined, h.ctx),
    /VM unavailable/,
  );
  await h.toggle();
  await checkTools(h, false);
  await assert.rejects(h.toggle(), /VM unavailable/);
  await checkTools(h, false);
  assert.equal(await h.emit("user_bash"), undefined);
  state.failStart = false;
  await h.toggle();
  await checkTools(h, true);
  await h.emit("session_shutdown");
});

test("shutdown waits for pending startup and closes it without publishing", async () => {
  const h = await setup();
  state.startBarrier = Promise.withResolvers<void>();
  const starting = h.emit("session_start");
  const rejected = assert.rejects(starting, /shut down/);
  await waitForVmStart();
  const closing = h.emit("session_shutdown");
  state.startBarrier.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(state.closes, 1);
  assert.doesNotMatch(h.notices.join("\n"), /VM ready/);
  await assert.rejects(h.emit("user_bash"), /shut down/);
});

test("concurrent startup shares one VM", async () => {
  const h = await setup();
  state.startBarrier = Promise.withResolvers<void>();
  const calls = [
    h.emit("session_start"),
    h.emit("user_bash"),
    h.emit("before_agent_start", prompt),
  ];
  await waitForVmStart();
  state.startBarrier.resolve();
  await Promise.all(calls);
  await h.emit("session_shutdown");
  assert.equal(state.closes, 1);
});

test("concurrent shutdown waits for one close and never restarts VM", async () => {
  const h = await setup();
  await h.emit("session_start");
  state.closeBarrier = Promise.withResolvers<void>();
  const first = h.emit("session_shutdown");
  const second = h.emit("session_shutdown");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.closes, 1);
  await assert.rejects(h.emit("user_bash"), /shut down/);
  state.closeBarrier.resolve();
  await Promise.all([first, second]);
  await h.emit("session_shutdown");
  assert.equal(state.closes, 1);
});

test("shutdown before first use prevents VM creation", async () => {
  const h = await setup();
  await h.emit("session_shutdown");
  await assert.rejects(h.emit("session_start"), /shut down/);
  assert.equal(state.starts, 0);
});
