import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
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

test("sandbox instructions replace only global context and stay fixed across toggles", async () => {
  const sandboxPath = path.join(state.configDir, "SANDBOX_AGENTS.md");
  await writeFile(sandboxPath, "Sandbox rules\n");
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({
      _version: 0,
      mounts: [],
      sandboxAgentsFile: "./SANDBOX_AGENTS.md",
    }),
  );
  const global = {
    path: path.join(state.configDir, "AGENTS.override.md"),
    content: "Host-only rules",
  };
  const ancestor = {
    path: path.join(state.homeDir, "AGENTS.md"),
    content: "Ancestor rules",
  };
  const project = {
    path: path.join(process.cwd(), "AGENTS.md"),
    content: "Project rules",
  };
  const event = {
    systemPromptOptions: {
      ...prompt.systemPromptOptions,
      contextFiles: [global, ancestor, project],
    },
  };
  const h = await setup();
  await h.emit("session_start");
  for (let i = 0; i < 3; i++) {
    const result = await h.emit("before_agent_start", event);
    const text = result?.systemPrompt ?? "";
    assert.match(text, /Sandbox rules/);
    assert.doesNotMatch(text, /Host-only rules/);
    assert.match(text, /Ancestor rules/);
    assert.match(text, /Project rules/);
    assert.deepEqual(event.systemPromptOptions.contextFiles, [
      global,
      ancestor,
      project,
    ]);
    await writeFile(sandboxPath, "Changed during session\n");
    await h.toggle();
  }
  await h.emit("session_shutdown");
});

test("unset sandbox instruction file preserves normal global and project context", async () => {
  const h = await setup();
  const global = {
    path: path.join(state.configDir, "AGENTS.md"),
    content: "Normal global rules",
  };
  const project = {
    path: path.join(process.cwd(), "AGENTS.md"),
    content: "Project rules",
  };
  const result = await h.emit("before_agent_start", {
    systemPromptOptions: {
      ...prompt.systemPromptOptions,
      contextFiles: [global, project],
    },
  });
  assert.match(result?.systemPrompt ?? "", /Normal global rules/);
  assert.match(result?.systemPrompt ?? "", /Project rules/);
  await h.emit("session_shutdown");
});

test("empty sandbox instruction file suppresses global context without needing a global file", async () => {
  await writeFile(path.join(state.configDir, "SANDBOX_AGENTS.md"), "");
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({
      _version: 0,
      mounts: [],
      sandboxAgentsFile: "SANDBOX_AGENTS.md",
    }),
  );
  const h = await setup();
  const project = {
    path: path.join(process.cwd(), "AGENTS.md"),
    content: "Project rules",
  };
  for (const contextFiles of [
    [
      {
        path: path.join(state.configDir, "AGENTS.md"),
        content: "Host-only rules",
      },
      project,
    ],
    [project],
  ]) {
    const result = await h.emit("before_agent_start", {
      systemPromptOptions: { ...prompt.systemPromptOptions, contextFiles },
    });
    assert.doesNotMatch(result?.systemPrompt ?? "", /Host-only rules/);
    assert.match(result?.systemPrompt ?? "", /SANDBOX_AGENTS.md/);
    assert.match(result?.systemPrompt ?? "", /Project rules/);
  }
  await h.emit("session_shutdown");
});

test("missing configured sandbox instruction file blocks VM startup", async () => {
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({
      _version: 0,
      mounts: [],
      sandboxAgentsFile: "missing.md",
    }),
  );
  const h = await setup();
  await assert.rejects(
    h.emit("session_start"),
    /gondolin-rises.json.*missing.md/,
  );
  assert.equal(state.starts, 0);
});

test("unreadable sandbox instruction file blocks VM startup with file path", async (t) => {
  if (process.getuid?.() === 0)
    return t.skip("root can read files without permissions");
  const file = path.join(state.configDir, "SANDBOX_AGENTS.md");
  await writeFile(file, "Sandbox rules\n");
  await chmod(file, 0);
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({
      _version: 0,
      mounts: [],
      sandboxAgentsFile: "SANDBOX_AGENTS.md",
    }),
  );
  const h = await setup();
  await assert.rejects(
    h.emit("session_start"),
    /Cannot read sandboxAgentsFile:.*SANDBOX_AGENTS.md/,
  );
  assert.equal(state.starts, 0);
  assert.match(h.notices.join("\n"), /Cannot read sandboxAgentsFile/);
});
