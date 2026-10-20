import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { mock, test } from "node:test";
import { checkTools, prompt, setup, state } from "./test-fixtures.ts";

test("extension creates version-zero config in Pi config directory", async () => {
  await rm(state.configFile, { force: true });
  await setup();
  assert.deepEqual(JSON.parse(await readFile(state.configFile, "utf8")), {
    version: 0,
    image: { packages: [] },
  });
});

test("extension does not rewrite existing config", async () => {
  const existing = '{"version":0}\n';
  await writeFile(state.configFile, existing);
  await setup();
  assert.equal(await readFile(state.configFile, "utf8"), existing);
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
