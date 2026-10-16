import assert from "node:assert/strict";
import { mock, test } from "node:test";

function tool(name, cwd, options = {}) {
  return {
    name,
    execute: async (...args) => ({
      name,
      cwd,
      operations: options.operations,
      args,
    }),
  };
}

let starts = 0;
let closes = 0;
let failStart = false;
const vm = { close: async () => closes++, fs: {} };

mock.module("@earendil-works/pi-coding-agent", {
  namedExports: Object.fromEntries(
    ["Read", "Write", "Edit", "Bash"].map((name) => [
      `create${name}Tool`,
      (cwd, options) => tool(name.toLowerCase(), cwd, options),
    ]),
  ),
});
mock.module("@earendil-works/gondolin", {
  namedExports: {
    RealFSProvider: class {},
    VM: {
      create: async () => {
        starts++;
        if (failStart) throw new Error("VM unavailable");
        return vm;
      },
    },
  },
});
const { default: extension } = await import("./index.ts");

function setup() {
  starts = 0;
  closes = 0;
  failStart = false;
  const events = new Map();
  const commands = new Map();
  const tools = new Map();
  const statuses = [];
  const notices = [];
  const ctx = {
    waitForIdle: mock.fn(async () => {}),
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus: (_key, text) => statuses.push(text),
      notify: (text) => notices.push(text),
    },
  };
  extension({
    on: (name, handler) => events.set(name, handler),
    registerTool: (definition) => tools.set(definition.name, definition),
    registerCommand: (name, command) => commands.set(name, command),
  });
  return {
    ctx,
    tools,
    statuses,
    notices,
    emit: (name, event = {}) => events.get(name)(event, ctx),
    toggle: () => commands.get("sandbox").handler("", ctx),
  };
}

const prompt = { systemPrompt: `Current working directory: ${process.cwd()}` };

async function checkTools(harness, sandboxed) {
  const signal = new AbortController().signal;
  const update = () => {};
  for (const definition of harness.tools.values()) {
    const params = { path: "example" };
    const result = await definition.execute(
      "id",
      params,
      signal,
      update,
      harness.ctx,
    );
    assert.equal(Boolean(result.operations), sandboxed, definition.name);
    assert.deepEqual(result.args, ["id", params, signal, update]);
  }
}

test("sandbox defaults on; toggle routes every tool, user bash, and prompt", async () => {
  const h = setup();
  await h.emit("session_start");
  await checkTools(h, true);
  assert.ok((await h.emit("user_bash")).operations);
  assert.match(
    (await h.emit("before_agent_start", prompt)).systemPrompt,
    /Gondolin VM/,
  );

  await h.toggle();
  assert.equal(h.ctx.waitForIdle.mock.callCount(), 1);
  await checkTools(h, false);
  assert.equal(await h.emit("user_bash"), undefined);
  assert.equal(await h.emit("before_agent_start", prompt), undefined);
  assert.match(h.statuses.at(-1), /off.*host/i);
  assert.match(h.notices.at(-1), /off.*host/i);
  assert.equal(closes, 0);

  await h.toggle();
  await checkTools(h, true);
  assert.ok((await h.emit("user_bash")).operations);
  assert.match(
    (await h.emit("before_agent_start", prompt)).systemPrompt,
    /Gondolin VM/,
  );
  assert.match(h.statuses.at(-1), /on/i);
  assert.match(h.notices.at(-1), /on/i);
  assert.equal(starts, 1);
  await h.toggle();
  await h.emit("session_shutdown");
  await h.emit("session_shutdown");
  assert.equal(closes, 1);
});

test("user bash starts VM lazily rather than falling through to host", async () => {
  const h = setup();
  assert.ok((await h.emit("user_bash")).operations);
  assert.equal(starts, 1);
  await h.emit("session_shutdown");
});

test("failed startup stays sandboxed, supports off, and retries safely", async () => {
  const h = setup();
  failStart = true;
  await assert.rejects(h.emit("session_start"), /VM unavailable/);
  await assert.rejects(h.emit("user_bash"), /VM unavailable/);
  await assert.rejects(
    h.tools.get("read").execute("id", {}, undefined, undefined, h.ctx),
    /VM unavailable/,
  );
  await h.toggle();
  await checkTools(h, false);
  await assert.rejects(h.toggle(), /VM unavailable/);
  await checkTools(h, false);
  assert.equal(await h.emit("user_bash"), undefined);
  failStart = false;
  await h.toggle();
  await checkTools(h, true);
  await h.emit("session_shutdown");
});

test("toggle waits for idle before changing routing", async () => {
  const h = setup();
  await h.emit("session_start");
  const idle = Promise.withResolvers();
  h.ctx.waitForIdle = () => idle.promise;
  const toggling = h.toggle();
  await checkTools(h, true);
  idle.resolve();
  await toggling;
  await checkTools(h, false);
  await h.emit("session_shutdown");
});
