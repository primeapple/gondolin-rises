import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mock, test } from "node:test";
import { checkTools, prompt, setup, state } from "./test-fixtures.ts";

test("extension leaves missing config absent", async () => {
  await setup();
  await assert.rejects(readFile(state.configFile, "utf8"), { code: "ENOENT" });
});

test("extension does not rewrite existing config", async () => {
  const existing = '{"arch":"x86_64","distro":"alpine"}\n';
  await writeFile(state.configFile, existing);
  await setup();
  assert.equal(await readFile(state.configFile, "utf8"), existing);
});

test("invalid mount config blocks VM startup", async () => {
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    '{"_version":0,"mounts":["missing"]}',
  );
  const h = await setup();
  await assert.rejects(h.emit("session_start"), /gondolin-rises.json/);
  assert.equal(state.starts, 0);
  assert.match(h.notices.join("\n"), /gondolin-rises.json/);
});

test("startup reports missing runtime dependencies without starting VM", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const h = await setup();
    await assert.rejects(h.emit("session_start"), /qemu-system-x86_64/);
    assert.equal(state.starts, 0);
    assert.match(h.notices.join("\n"), /qemu-system-x86_64.*qemu-img/s);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("image update skips build and reports missing prerequisites", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({ arch: "x86_64", distro: "alpine" }),
  );
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  process.env.PATH = "";
  try {
    const h = await setup({ "update-gondolin-image": true });
    await h.emit("session_start");
    assert.equal(state.builds, 0);
    assert.equal(h.ctx.shutdown.mock.callCount(), 1);
    assert.equal(process.exitCode, 1);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
  }
});

test("sandbox defaults on; toggle routes every tool, user bash, and prompt", async () => {
  const h = await setup();
  await h.emit("session_start");
  assert.equal(state.builds, 0);
  assert.equal(state.vmOptions[0].sandbox, undefined);
  await checkTools(h, true);
  assert.ok((await h.emit("user_bash"))?.operations);
  assert.match(
    (await h.emit("before_agent_start", prompt))?.systemPrompt ?? "",
    /Gondolin VM/,
  );

  await h.toggle();
  assert.equal(h.ctx.waitForIdle.mock.callCount(), 1);
  await checkTools(h, false);
  assert.equal(await h.emit("user_bash"), undefined);
  assert.equal(await h.emit("before_agent_start", prompt), undefined);
  assert.match(h.statuses.at(-1) ?? "", /off.*host/i);
  assert.match(h.notices.at(-1) ?? "", /off.*host/i);
  assert.equal(state.closes, 0);

  await h.toggle();
  await checkTools(h, true);
  assert.ok((await h.emit("user_bash"))?.operations);
  assert.match(
    (await h.emit("before_agent_start", prompt))?.systemPrompt ?? "",
    /Gondolin VM/,
  );
  assert.match(h.statuses.at(-1) ?? "", /on/i);
  assert.match(h.notices.at(-1) ?? "", /on/i);
  assert.equal(state.starts, 1);
  await h.toggle();
  await h.emit("session_shutdown");
  await h.emit("session_shutdown");
  assert.equal(state.closes, 1);
});

test("toggle waits for idle before changing routing", async () => {
  const h = await setup();
  await h.emit("session_start");
  const idle = Promise.withResolvers<void>();
  h.ctx.waitForIdle = mock.fn(() => idle.promise);
  const toggling = h.toggle();
  await checkTools(h, true);
  idle.resolve();
  await toggling;
  await checkTools(h, false);
  await h.emit("session_shutdown");
});
