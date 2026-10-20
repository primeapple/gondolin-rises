import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";

const configDir = await mkdtemp(path.join(os.tmpdir(), "gondolin-rises-"));
const configFile = path.join(configDir, "gondolin-rises.json");
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
process.env.XDG_CACHE_HOME = path.join(configDir, "cache");
after(async () => {
  await rm(configDir, { recursive: true, force: true });
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
});

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
let builds = 0;
let buildConfigs = [];
let vmOptions = [];
let gondolinVersion = "v0.13.0";
let failStart = false;
let failBuild = false;
const vm = { close: async () => closes++, fs: {} };

mock.module("@earendil-works/pi-coding-agent", {
  namedExports: {
    ...Object.fromEntries(
      ["Read", "Write", "Edit", "Bash"].map((name) => [
        `create${name}Tool`,
        (cwd, options) => tool(name.toLowerCase(), cwd, options),
      ]),
    ),
    getAgentDir: () => configDir,
  },
});
mock.module("@earendil-works/gondolin", {
  namedExports: {
    RealFSProvider: class {},
    VM: {
      create: async (options) => {
        starts++;
        vmOptions.push(options);
        if (failStart) throw new Error("VM unavailable");
        return vm;
      },
    },
    buildAssets: async (config, options) => {
      builds++;
      buildConfigs.push(config);
      if (failBuild) throw new Error("image build failed");
      await mkdir(options.outputDir, { recursive: true });
      await writeFile(path.join(options.outputDir, "built"), "ok");
      await writeFile(
        path.join(options.outputDir, "manifest.json"),
        JSON.stringify({ config }),
      );
      return { outputDir: options.outputDir };
    },
    loadAssetManifest: (dir) => {
      try {
        return JSON.parse(
          readFileSync(path.join(dir, "manifest.json"), "utf8"),
        );
      } catch {
        return null;
      }
    },
    loadGuestAssets: (dir) => {
      if (!existsSync(path.join(dir, "built"))) {
        throw new Error("incomplete guest image");
      }
      return {};
    },
    getAssetVersion: () => gondolinVersion,
    getDefaultBuildConfig: () => ({
      arch: "x86_64",
      distro: "alpine",
      alpine: { rootfsPackages: ["linux-virt", "bash"] },
    }),
  },
});
const { default: extension } = await import("./src/index.ts");

async function setup(flags = {}) {
  starts = 0;
  closes = 0;
  builds = 0;
  buildConfigs = [];
  vmOptions = [];
  failStart = false;
  failBuild = false;
  const events = new Map();
  const commands = new Map();
  const registeredFlags = new Map();
  const tools = new Map();
  const statuses = [];
  const notices = [];
  const ctx = {
    waitForIdle: mock.fn(async () => {}),
    shutdown: mock.fn(),
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus: (_key, text) => statuses.push(text),
      notify: (text) => notices.push(text),
    },
  };
  await extension({
    on: (name, handler) => events.set(name, handler),
    registerTool: (definition) => tools.set(definition.name, definition),
    registerCommand: (name, command) => commands.set(name, command),
    registerFlag: (name, flag) => registeredFlags.set(name, flag),
    getFlag: (name) => flags[name],
  });
  return {
    ctx,
    tools,
    statuses,
    notices,
    registeredFlags,
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

test("extension creates version-zero config in Pi config directory", async () => {
  await rm(configFile, { force: true });
  await setup();
  assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), {
    version: 0,
    image: { packages: [] },
  });
});

test("extension does not rewrite existing config", async () => {
  const existing = '{"version":0}\n';
  await writeFile(configFile, existing);
  await setup();
  assert.equal(await readFile(configFile, "utf8"), existing);
});

test("sandbox defaults on; toggle routes every tool, user bash, and prompt", async () => {
  const h = await setup();
  await h.emit("session_start");
  assert.equal(builds, 0);
  assert.equal(vmOptions[0].sandbox, undefined);
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
  const h = await setup();
  assert.ok((await h.emit("user_bash")).operations);
  assert.equal(starts, 1);
  await h.emit("session_shutdown");
});

test("failed startup stays sandboxed, supports off, and retries safely", async () => {
  const h = await setup();
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
  const h = await setup();
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

test("configured images do not build on startup and warn until manually built", async () => {
  await rm(path.join(process.env.XDG_CACHE_HOME, "gondolin-rises"), {
    recursive: true,
    force: true,
  });
  await writeFile(
    configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );

  const h = await setup();
  assert.deepEqual(h.registeredFlags.get("update-gondolin-image"), {
    description: "Rebuild the custom Gondolin image",
    type: "boolean",
  });
  await h.emit("session_start");
  assert.equal(builds, 0);
  assert.equal(vmOptions[0].sandbox, undefined);
  assert.match(h.notices.join("\n"), /pi --update-gondolin-image/);
  await h.emit("session_shutdown");
});

test("manual image update installs a pointer and startup reuses it", async () => {
  await rm(path.join(process.env.XDG_CACHE_HOME, "gondolin-rises"), {
    recursive: true,
    force: true,
  });
  gondolinVersion = "v0.13.0";
  await writeFile(
    configFile,
    JSON.stringify({ version: 0, image: { packages: ["git", "file"] } }),
  );

  const updater = await setup({ "update-gondolin-image": true });
  await updater.emit("session_start");
  assert.equal(builds, 1);
  assert.deepEqual(buildConfigs[0].alpine.rootfsPackages, [
    "linux-virt",
    "bash",
    "git",
    "file",
  ]);
  assert.equal(starts, 0);
  assert.equal(updater.ctx.shutdown.mock.callCount(), 1);

  const imagesDir = path.join(
    process.env.XDG_CACHE_HOME,
    "gondolin-rises",
    "images",
  );
  const pointer = JSON.parse(
    await readFile(path.join(imagesDir, "active.json"), "utf8"),
  );
  const imagePath = path.join(imagesDir, pointer.imageKey, pointer.buildId);
  assert.ok(existsSync(imagePath));

  const next = await setup();
  await next.emit("session_start");
  assert.equal(builds, 0);
  assert.equal(vmOptions[0].sandbox.imagePath, imagePath);
  assert.doesNotMatch(next.notices.join("\n"), /outdated|No custom/i);
  await next.emit("session_shutdown");

  const refresh = await setup({ "update-gondolin-image": true });
  await refresh.emit("session_start");
  assert.equal(builds, 1);
  const refreshed = JSON.parse(
    await readFile(path.join(imagesDir, "active.json"), "utf8"),
  );
  assert.notEqual(refreshed.buildId, pointer.buildId);
  assert.ok(existsSync(imagePath));
});

test("stale image stays active until update succeeds", async () => {
  await rm(path.join(process.env.XDG_CACHE_HOME, "gondolin-rises"), {
    recursive: true,
    force: true,
  });
  gondolinVersion = "v0.13.0";
  await writeFile(
    configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const imagesDir = path.join(
    process.env.XDG_CACHE_HOME,
    "gondolin-rises",
    "images",
  );
  const firstPointer = JSON.parse(
    await readFile(path.join(imagesDir, "active.json"), "utf8"),
  );
  const firstPath = path.join(
    imagesDir,
    firstPointer.imageKey,
    firstPointer.buildId,
  );

  await writeFile(
    configFile,
    JSON.stringify({ version: 0, image: { packages: ["ripgrep"] } }),
  );
  const stale = await setup();
  await stale.emit("session_start");
  assert.equal(builds, 0);
  assert.equal(vmOptions[0].sandbox.imagePath, firstPath);
  assert.match(
    stale.notices.join("\n"),
    /outdated.*pi --update-gondolin-image/i,
  );
  await stale.emit("session_shutdown");

  const staleAgain = await setup();
  await staleAgain.emit("session_start");
  assert.match(staleAgain.notices.join("\n"), /outdated/);
  await staleAgain.emit("session_shutdown");

  const updater = await setup({ "update-gondolin-image": true });
  await updater.emit("session_start");
  assert.equal(builds, 1);
  const nextPointer = JSON.parse(
    await readFile(path.join(imagesDir, "active.json"), "utf8"),
  );
  assert.notEqual(nextPointer.buildId, firstPointer.buildId);
  assert.ok(existsSync(firstPath));
});

test("failed image update leaves active pointer unchanged", async () => {
  await rm(path.join(process.env.XDG_CACHE_HOME, "gondolin-rises"), {
    recursive: true,
    force: true,
  });
  await writeFile(
    configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const pointerPath = path.join(
    process.env.XDG_CACHE_HOME,
    "gondolin-rises",
    "images",
    "active.json",
  );
  const activeBefore = await readFile(pointerPath, "utf8");
  const originalExitCode = process.exitCode;

  try {
    const updater = await setup({ "update-gondolin-image": true });
    failBuild = true;
    await updater.emit("session_start");
    assert.equal(updater.ctx.shutdown.mock.callCount(), 1);
    assert.equal(await readFile(pointerPath, "utf8"), activeBefore);
    assert.equal(process.exitCode, 1);
  } finally {
    failBuild = false;
    process.exitCode = originalExitCode;
  }
});

test("legacy cached image becomes active pointer without startup rebuild", async () => {
  await rm(path.join(process.env.XDG_CACHE_HOME, "gondolin-rises"), {
    recursive: true,
    force: true,
  });
  await writeFile(
    configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  const imagesDir = path.join(
    process.env.XDG_CACHE_HOME,
    "gondolin-rises",
    "images",
  );
  const imageKey = "a".repeat(64);
  const imagePath = path.join(imagesDir, imageKey);
  await mkdir(imagePath, { recursive: true });
  await writeFile(path.join(imagePath, "built"), "ok");
  await writeFile(
    path.join(imagePath, "manifest.json"),
    JSON.stringify({
      config: {
        arch: "x86_64",
        distro: "alpine",
        alpine: { rootfsPackages: ["linux-virt", "bash", "git"] },
      },
    }),
  );

  const startup = await setup();
  await startup.emit("session_start");
  assert.equal(builds, 0);
  assert.equal(vmOptions[0].sandbox.imagePath, imagePath);
  assert.match(startup.notices.join("\n"), /outdated/);
  const pointer = JSON.parse(
    await readFile(path.join(imagesDir, "active.json"), "utf8"),
  );
  assert.equal(pointer.imageKey, imageKey);
  assert.equal(pointer.assetVersion, null);
  await startup.emit("session_shutdown");
});

test("Gondolin version change warns and keeps active custom image", async () => {
  await rm(path.join(process.env.XDG_CACHE_HOME, "gondolin-rises"), {
    recursive: true,
    force: true,
  });
  gondolinVersion = "v0.13.0";
  await writeFile(
    configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const imagesDir = path.join(
    process.env.XDG_CACHE_HOME,
    "gondolin-rises",
    "images",
  );
  const pointer = JSON.parse(
    await readFile(path.join(imagesDir, "active.json"), "utf8"),
  );
  const imagePath = path.join(imagesDir, pointer.imageKey, pointer.buildId);

  gondolinVersion = "v0.14.0";
  const h = await setup();
  await h.emit("session_start");
  assert.equal(builds, 0);
  assert.equal(vmOptions[0].sandbox.imagePath, imagePath);
  assert.match(h.notices.join("\n"), /outdated/);
  await h.emit("session_shutdown");
  gondolinVersion = "v0.13.0";
});
