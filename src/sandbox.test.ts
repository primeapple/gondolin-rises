import assert from "node:assert/strict";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import type { VirtualProvider } from "@earendil-works/gondolin";
import { guestWorkspacePath } from "./operations.ts";
import { checkTools, prompt, setup, state } from "./test-fixtures.ts";

async function waitForVmStart() {
  const deadline = Date.now() + 1000;
  while (state.starts === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(state.starts, 1);
}

test("secret without hosts substitutes on every host", async () => {
  const envName = "GONDOLIN_RISES_TEST_UNRESTRICTED_TOKEN";
  const previous = process.env[envName];
  process.env[envName] = "test-token-value";
  try {
    await writeFile(
      path.join(state.configDir, "gondolin-rises.json"),
      JSON.stringify({
        _version: 0,
        mounts: [],
        secrets: { GH_TOKEN: { hostEnv: envName } },
      }),
    );
    const h = await setup();
    await h.emit("session_start");
    assert.deepEqual(state.httpHookOptions, [
      { secrets: { GH_TOKEN: { value: "test-token-value", hosts: ["*"] } } },
    ]);
    const { env, httpHooks } = state.vmOptions[0];
    assert.ok(env && !Array.isArray(env));
    assert.ok(env.GH_TOKEN);
    assert.notEqual(env.GH_TOKEN, "test-token-value");
    const onRequest = httpHooks?.onRequest;
    assert.ok(onRequest);
    for (const host of ["api.github.com", "example.org"]) {
      const request = new Request(`https://${host}/`, {
        headers: { Authorization: `Bearer ${env.GH_TOKEN}` },
      });
      const result: unknown = await onRequest(request);
      assert.ok(result instanceof Request);
      assert.equal(
        result.headers.get("Authorization"),
        "Bearer test-token-value",
      );
    }
    await h.emit("session_shutdown");
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test("user bash starts VM lazily rather than falling through to host", async () => {
  const h = await setup();
  assert.ok((await h.emit("user_bash"))?.operations);
  assert.equal(state.starts, 1);
  await h.emit("session_shutdown");
});

test("mounts CWD and configured host directory at same guest paths", async () => {
  const hostMount = path.join(state.configDir, "shared skills");
  await mkdir(hostMount);
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({ _version: 0, mounts: ["shared skills"] }),
  );
  const h = await setup();
  const cwd = process.cwd();
  await h.emit("session_start");

  const mounts = state.vmOptions[0]?.vfs?.mounts;
  assert.deepEqual(Object.keys(mounts ?? {}), [
    cwd,
    guestWorkspacePath(hostMount),
  ]);

  const result = await h.emit("before_agent_start", prompt);
  assert.ok(
    result?.systemPrompt.includes(
      `<cwd>\n${cwd} (Gondolin VM, mounted from host: ${cwd})\n</cwd>`,
    ),
  );
  await h.emit("session_shutdown");
});

test("injects secret placeholders and HTTP hooks into VM without exposing values", async () => {
  const envName = "GONDOLIN_RISES_TEST_TOKEN";
  const previous = process.env[envName];
  process.env[envName] = "test-token-value";
  try {
    await writeFile(
      path.join(state.configDir, "gondolin-rises.json"),
      JSON.stringify({
        _version: 0,
        mounts: [],
        secrets: {
          GH_TOKEN: { hostEnv: envName, hosts: ["api.github.com"] },
        },
      }),
    );
    const h = await setup();
    await h.emit("session_start");
    assert.deepEqual(state.httpHookOptions, [
      {
        secrets: {
          GH_TOKEN: {
            value: "test-token-value",
            hosts: ["api.github.com"],
          },
        },
      },
    ]);
    const env = state.vmOptions[0].env;
    assert.ok(env && !Array.isArray(env));
    assert.ok(env.GH_TOKEN);
    assert.notEqual(env.GH_TOKEN, "test-token-value");
    assert.equal(env.HOME, guestWorkspacePath(state.homeDir));
    assert.deepEqual(Object.keys(env).sort(), ["GH_TOKEN", "HOME"]);
    assert.ok(state.httpHooks);
    assert.strictEqual(state.vmOptions[0].httpHooks, state.httpHooks);
    await h.emit("session_shutdown");
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test("missing or empty secret credential warns and does not block VM startup", async () => {
  const envName = "GONDOLIN_RISES_MISSING_TOKEN";
  const previous = process.env[envName];
  try {
    await writeFile(
      path.join(state.configDir, "gondolin-rises.json"),
      JSON.stringify({
        _version: 0,
        mounts: [],
        secrets: {
          GH_TOKEN: { hostEnv: envName, hosts: ["api.github.com"] },
        },
      }),
    );
    for (const value of [undefined, ""] as const) {
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
      const h = await setup();
      await h.emit("session_start");
      assert.equal(state.starts, 1);
      assert.match(
        h.notices.join("\n"),
        new RegExp(`Missing secret environment variable ${envName}`),
      );
      assert.ok(
        h.ctx.ui.notify.mock.calls.some(
          (call) => call.arguments[1] === "warning",
        ),
      );
      assert.equal(state.httpHookOptions.length, 0);
      await h.emit("session_shutdown");
    }
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test("root CWD remains blocked even with configured root mount", async () => {
  const h = await setup();
  const root = path.parse(process.cwd()).root;
  const { createSandbox } = await import("./sandbox.ts");
  const sandbox = createSandbox(root, null, [root]);
  await assert.rejects(
    sandbox.ensureVm(h.ctx),
    /outside user home and temp directory/,
  );
  assert.equal(state.starts, 0);
  assert.match(h.notices.join("\n"), /outside user home and temp directory/);
  await sandbox.close(h.ctx);
});

for (const useSymlink of [false, true]) {
  test(`blocks CWD outside home and temp${useSymlink ? " through symlink" : ""}`, async () => {
    const h = await setup();
    const outside = path.join(state.testDir, "outside");
    await mkdir(outside);
    const link = path.join(state.homeDir, "outside-link");
    if (useSymlink) await symlink(outside, link);
    const { createSandbox } = await import("./sandbox.ts");
    const sandbox = createSandbox(useSymlink ? link : outside, null, []);
    await assert.rejects(
      sandbox.ensureVm(h.ctx),
      /outside user home and temp directory/,
    );
    assert.equal(state.starts, 0);
    await sandbox.close(h.ctx);
  });
}

for (const target of ["root", "outside", "home-sibling", "symlink"]) {
  test(`blocks configured ${target} mount before VM starts`, async () => {
    const outside = path.join(state.testDir, "home-sibling");
    await mkdir(outside);
    let mount = path.relative(state.configDir, outside);
    if (target === "root") {
      mount = path.relative(state.configDir, path.parse(state.configDir).root);
    } else if (target === "outside") {
      mount = path.relative(state.configDir, state.testDir);
    } else if (target === "symlink") {
      await symlink(outside, path.join(state.configDir, "outside-link"));
      mount = "outside-link";
    }
    await writeFile(
      path.join(state.configDir, "gondolin-rises.json"),
      JSON.stringify({ _version: 0, mounts: [".", mount] }),
    );
    const h = await setup();
    await assert.rejects(
      h.emit("session_start"),
      /outside user home and temp directory/,
    );
    assert.equal(state.starts, 0);
    assert.match(h.notices.join("\n"), /outside user home and temp directory/);
    await h.emit("session_shutdown");
  });
}

test("allows canonical home and in-home symlink mounts without warnings", async () => {
  const link = path.join(state.configDir, "home-link");
  const homeAlias = path.join(state.testDir, "home-alias");
  await symlink(state.homeDir, link);
  await symlink(state.homeDir, homeAlias);
  const homeMock = mock.method(os, "homedir", () => homeAlias);
  try {
    await writeFile(
      path.join(state.configDir, "gondolin-rises.json"),
      JSON.stringify({
        _version: 0,
        mounts: [path.relative(state.configDir, state.homeDir), "home-link"],
      }),
    );
    const h = await setup();
    await h.emit("session_start");
    assert.deepEqual(Object.keys(state.vmOptions[0]?.vfs?.mounts ?? {}), [
      process.cwd(),
      guestWorkspacePath(state.homeDir),
      guestWorkspacePath(link),
    ]);
    assert.deepEqual(h.notices, [
      `Gondolin VM ready. Host CWD mounted at same guest path: ${guestWorkspacePath(process.cwd())}`,
    ]);
    await h.emit("session_shutdown");
  } finally {
    homeMock.mock.restore();
  }
});

for (const useSymlink of [false, true]) {
  test(`allows temp CWD${useSymlink ? " through symlink" : ""}`, async () => {
    const h = await setup();
    const workspace = path.join(state.tempDir, "project");
    await mkdir(workspace);
    const link = path.join(state.homeDir, "temp-link");
    if (useSymlink) await symlink(workspace, link);
    const cwd = useSymlink ? link : workspace;
    const { createSandbox } = await import("./sandbox.ts");
    const sandbox = createSandbox(cwd, null, []);
    await sandbox.ensureVm(h.ctx);
    assert.equal(state.starts, 1);
    assert.deepEqual(Object.keys(state.vmOptions[0]?.vfs?.mounts ?? {}), [
      guestWorkspacePath(cwd),
    ]);
    await sandbox.close(h.ctx);
  });
}

test("allows canonical temp directory and configured symlink mounts", async () => {
  const link = path.join(state.configDir, "temp-link");
  const tempAlias = path.join(state.testDir, "temp-alias");
  await symlink(state.tempDir, link);
  await symlink(state.tempDir, tempAlias);
  const tempMock = mock.method(os, "tmpdir", () => tempAlias);
  try {
    await writeFile(
      path.join(state.configDir, "gondolin-rises.json"),
      JSON.stringify({
        _version: 0,
        mounts: [path.relative(state.configDir, state.tempDir), "temp-link"],
      }),
    );
    const h = await setup();
    await h.emit("session_start");
    assert.deepEqual(Object.keys(state.vmOptions[0]?.vfs?.mounts ?? {}), [
      process.cwd(),
      guestWorkspacePath(state.tempDir),
      guestWorkspacePath(link),
    ]);
    assert.deepEqual(h.notices, [
      `Gondolin VM ready. Host CWD mounted at same guest path: ${guestWorkspacePath(process.cwd())}`,
    ]);
    await h.emit("session_shutdown");
  } finally {
    tempMock.mock.restore();
  }
});

test("checks mount target again after config loads", async () => {
  const link = path.join(state.configDir, "changing-link");
  await symlink(state.homeDir, link);
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({ _version: 0, mounts: ["changing-link"] }),
  );
  const h = await setup();
  await unlink(link);
  await symlink(state.testDir, link);
  await assert.rejects(
    h.emit("session_start"),
    /outside user home and temp directory/,
  );
  assert.equal(state.starts, 0);
  await h.emit("session_shutdown");
});

test("Gondolin blocks host symlink escapes on access without scanning", async () => {
  const inside = path.join(process.cwd(), "inside.txt");
  const outside = path.join(state.testDir, "outside.txt");
  const sibling = path.join(state.homeDir, "sibling.txt");
  await writeFile(inside, "inside");
  await writeFile(outside, "outside");
  await writeFile(sibling, "sibling");
  await symlink(inside, path.join(process.cwd(), "safe-link"));
  await symlink(outside, path.join(process.cwd(), "escape-link"));
  await symlink(sibling, path.join(process.cwd(), "sibling-link"));
  const h = await setup();
  await h.emit("session_start");
  const provider = state.vmOptions[0]?.vfs?.mounts?.[process.cwd()];
  assert.ok(provider);
  assert.ok(provider.readFile);
  assert.ok(provider.writeFile);
  assert.equal((await provider.readFile("/safe-link")).toString(), "inside");
  await assert.rejects(provider.readFile("/escape-link"), /ENOENT/);
  await assert.rejects(provider.readFile("/sibling-link"), /ENOENT/);
  await assert.rejects(provider.writeFile("/escape-link", "changed"), /ENOENT/);
  assert.equal(await readFile(outside, "utf8"), "outside");
  await h.emit("session_shutdown");
});

test("session startup does not wait for VM readiness", async () => {
  const h = await setup();
  state.startBarrier = Promise.withResolvers<void>();
  const starting = h.emitFast("session_start");
  await waitForVmStart();
  const settled = await Promise.race([
    starting.then(() => true),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);
  state.startBarrier.resolve();
  await starting;
  assert.equal(settled, true);
  await h.emit("session_shutdown");
});

test("failed startup stays sandboxed, supports off, and retries safely", async () => {
  const h = await setup();
  state.failStart = true;
  await h.emitFast("session_start");
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
  const starting = h.emitFast("session_start");
  await waitForVmStart();
  const closing = h.emit("session_shutdown");
  state.startBarrier.resolve();
  await Promise.all([closing, starting]);
  assert.equal(state.closes, 1);
  assert.doesNotMatch(h.notices.join("\n"), /VM ready/);
  await assert.rejects(h.emit("user_bash"), /shut down/);
});

test("concurrent startup shares one VM", async () => {
  const h = await setup();
  state.startBarrier = Promise.withResolvers<void>();
  const calls = [
    h.emitFast("session_start"),
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

test("guest home matches host without mounting whole home or building image", async () => {
  const h = await setup();
  await h.emit("session_start");
  assert.deepEqual(state.vmOptions[0].env, {
    HOME: guestWorkspacePath(state.homeDir),
  });
  assert.deepEqual(state.vm.fs.mkdir.mock.calls[0].arguments, [
    guestWorkspacePath(state.homeDir),
    { recursive: true },
  ]);
  assert.deepEqual(Object.keys(state.vmOptions[0].vfs?.mounts ?? {}), [
    guestWorkspacePath(process.cwd()),
  ]);
  assert.equal(state.builds, 0);
  await h.emit("session_shutdown");
});

test("failed guest home setup closes VM without publication and allows retry", async () => {
  const h = await setup();
  state.vm.fs.mkdir.mock.mockImplementation(async () => {
    throw new Error("home setup failed");
  });
  await assert.rejects(h.emit("session_start"), /home setup failed/);
  assert.equal(state.closes, 1);
  assert.doesNotMatch(h.notices.join("\n"), /VM ready/);
  state.vm.fs.mkdir.mock.mockImplementation(async () => {});
  await h.emit("session_start");
  assert.equal(state.starts, 2);
  await h.emit("session_shutdown");
  assert.equal(state.closes, 2);
});

test("guest-only directories hide host trees and keep guest writes separate", async () => {
  const cwd = process.cwd();
  for (const directory of [
    "node_modules",
    "packages/app/node_modules",
    ".venv",
  ]) {
    await mkdir(path.join(cwd, directory), { recursive: true });
    await writeFile(path.join(cwd, directory, "host.txt"), "host dependency");
  }
  await mkdir(path.join(cwd, "node_modules_backup"));
  await mkdir(path.join(cwd, "case", "Node_modules"), { recursive: true });
  await writeFile(
    path.join(cwd, "case", "Node_modules", "host.txt"),
    "case-sensitive dependency",
  );
  await writeFile(path.join(cwd, "source.ts"), "host source");
  await writeFile(path.join(cwd, "package-lock.json"), "host lockfile");
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({
      _version: 0,
      mounts: [],
      guestOnlyDirectories: ["node_modules", ".venv"],
    }),
  );
  const h = await setup();
  await h.emit("session_start");
  const provider = state.vmOptions[0].vfs?.mounts?.[cwd];
  assert.ok(provider?.readFile && provider.writeFile);
  assert.deepEqual((await provider.readdir("/")).sort(), [
    "case",
    "node_modules_backup",
    "package-lock.json",
    "packages",
    "source.ts",
  ]);
  assert.equal(
    (await provider.readFile("/case/Node_modules/host.txt")).toString(),
    "case-sensitive dependency",
  );
  for (const directory of [
    "/node_modules",
    "/packages/app/node_modules",
    "/.venv",
  ]) {
    await assert.rejects(provider.readFile(`${directory}/host.txt`), /ENOENT/);
    await provider.mkdir(directory);
    await provider.writeFile(`${directory}/guest.txt`, "guest dependency");
    assert.equal(
      (await provider.readFile(`${directory}/guest.txt`)).toString(),
      "guest dependency",
    );
    assert.equal(
      await readFile(path.join(cwd, directory, "host.txt"), "utf8"),
      "host dependency",
    );
    await assert.rejects(
      readFile(path.join(cwd, directory, "guest.txt")),
      /ENOENT/,
    );
  }
  await provider.writeFile("/source.ts", "guest source");
  await provider.writeFile("/package-lock.json", "guest lockfile");
  assert.equal(
    await readFile(path.join(cwd, "source.ts"), "utf8"),
    "guest source",
  );
  assert.equal(
    await readFile(path.join(cwd, "package-lock.json"), "utf8"),
    "guest lockfile",
  );
  await h.emit("session_shutdown");
});

test("guest-only rules apply to every mount, including roots inside hidden trees and symlink aliases", async () => {
  const cwd = process.cwd();
  const dependency = path.join(cwd, "node_modules", "pkg");
  const extra = path.join(state.homeDir, "shared");
  await mkdir(dependency, { recursive: true });
  await mkdir(path.join(extra, "nested", "node_modules"), { recursive: true });
  await writeFile(path.join(dependency, "host.txt"), "host dependency");
  await writeFile(
    path.join(extra, "nested", "node_modules", "host.txt"),
    "extra host dependency",
  );
  const alias = path.join(state.configDir, "dependency-alias");
  await symlink(dependency, alias);
  const roots = [state.homeDir, extra, dependency, alias];
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({
      _version: 0,
      mounts: roots.map((root) => path.relative(state.configDir, root)),
      guestOnlyDirectories: ["node_modules"],
    }),
  );
  const h = await setup();
  await h.emit("session_start");
  const mounts = state.vmOptions[0].vfs?.mounts;
  assert.ok(mounts);
  for (const [root, hidden] of [
    [cwd, "/node_modules/pkg/host.txt"],
    [state.homeDir, "/project/node_modules/pkg/host.txt"],
    [extra, "/nested/node_modules/host.txt"],
    [dependency, "/host.txt"],
    [alias, "/host.txt"],
  ]) {
    const provider = mounts[guestWorkspacePath(root)];
    assert.ok(provider?.readFile && provider.writeFile);
    await assert.rejects(provider.readFile(hidden), /ENOENT/);
  }
  for (const root of [dependency, alias]) {
    const provider: VirtualProvider = mounts[guestWorkspacePath(root)];
    assert.ok(provider?.readFile && provider.writeFile);
    assert.deepEqual(await provider.readdir("/"), []);
    await provider.writeFile("/guest.txt", "guest dependency");
    assert.equal(
      (await provider.readFile("/guest.txt")).toString(),
      "guest dependency",
    );
    await assert.rejects(
      readFile(path.join(dependency, "guest.txt")),
      /ENOENT/,
    );
  }
  assert.equal(
    await readFile(path.join(dependency, "host.txt"), "utf8"),
    "host dependency",
  );
  await h.emit("session_shutdown");
});

test("guest-only rules hide later host entries and prevent symlink and rename bypasses", async () => {
  const cwd = process.cwd();
  await mkdir(path.join(cwd, "packages", "app"), { recursive: true });
  await writeFile(path.join(cwd, "source.txt"), "source");
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({
      _version: 0,
      mounts: [],
      guestOnlyDirectories: ["node_modules"],
    }),
  );
  const h = await setup();
  await h.emit("session_start");
  const provider = state.vmOptions[0].vfs?.mounts?.[cwd];
  assert.ok(provider?.readFile && provider.writeFile);
  const hostDirectory = path.join(cwd, "packages", "app", "node_modules");
  await mkdir(hostDirectory);
  await writeFile(path.join(hostDirectory, "host.txt"), "host dependency");
  await symlink("packages/app/node_modules", path.join(cwd, "alias"));
  await symlink(
    "packages/app/node_modules/host.txt",
    path.join(cwd, "file-alias"),
  );
  const outside = path.join(state.homeDir, "outside.txt");
  await writeFile(outside, "outside");
  await symlink(outside, path.join(cwd, "escape"));
  assert.deepEqual(await provider.readdir("/packages/app"), []);
  await assert.rejects(
    provider.readFile("/packages/app/node_modules/host.txt"),
    /ENOENT/,
  );
  for (const alias of ["/alias/host.txt", "/file-alias"]) {
    await assert.rejects(provider.readFile(alias), /ENOENT/);
    // Upstream may deny alias writes or route them to the separate upper layer.
    await provider.writeFile(alias, "changed").catch(() => {});
  }
  await assert.rejects(provider.readFile("/escape"), /ENOENT/);
  await assert.rejects(provider.writeFile("/escape", "changed"), /ENOENT/);
  await provider.mkdir("/packages/app/node_modules");
  await provider.writeFile(
    "/packages/app/node_modules/guest.txt",
    "guest dependency",
  );
  await provider.rename(
    "/packages/app/node_modules/guest.txt",
    "/packages/app/node_modules/renamed.txt",
  );
  assert.equal(
    (
      await provider.readFile("/packages/app/node_modules/renamed.txt")
    ).toString(),
    "guest dependency",
  );
  await assert.rejects(
    provider.rename("/source.txt", "/packages/app/node_modules/source.txt"),
  );
  await assert.rejects(
    provider.rename("/packages/app/node_modules/renamed.txt", "/exported.txt"),
  );
  await assert.rejects(provider.rename("/file-alias", "/moved.txt"));
  await provider.unlink("/packages/app/node_modules/renamed.txt");
  await provider.rmdir("/packages/app/node_modules");
  assert.equal(
    await readFile(path.join(hostDirectory, "host.txt"), "utf8"),
    "host dependency",
  );
  assert.equal(await readFile(path.join(cwd, "source.txt"), "utf8"), "source");
  assert.equal(await readFile(outside, "utf8"), "outside");
  await h.emit("session_shutdown");
});

test("empty guest-only config keeps host dependencies shared", async () => {
  const cwd = process.cwd();
  await mkdir(path.join(cwd, "node_modules"));
  await writeFile(
    path.join(cwd, "node_modules", "host.txt"),
    "host dependency",
  );
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({
      _version: 0,
      mounts: [],
      guestOnlyDirectories: [],
    }),
  );
  const h = await setup();
  await h.emit("session_start");
  const provider = state.vmOptions[0].vfs?.mounts?.[cwd];
  assert.ok(provider?.readFile && provider.writeFile);
  assert.equal(
    (await provider.readFile("/node_modules/host.txt")).toString(),
    "host dependency",
  );
  await provider.writeFile("/node_modules/host.txt", "shared dependency");
  assert.equal(
    await readFile(path.join(cwd, "node_modules", "host.txt"), "utf8"),
    "shared dependency",
  );
  await h.emit("session_shutdown");
});

test("invalid guest-only config fails startup before VM creation", async () => {
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({
      _version: 0,
      mounts: [],
      guestOnlyDirectories: ["packages/node_modules"],
    }),
  );
  const h = await setup();
  await assert.rejects(h.emit("session_start"), /guestOnlyDirectories/);
  await assert.rejects(h.emit("user_bash"), /guestOnlyDirectories/);
  assert.equal(state.starts, 0);
  assert.ok(
    h.ctx.ui.notify.mock.calls.some((call) => call.arguments[1] === "error"),
  );
  await h.emit("session_shutdown");
});

test("guest-only contents survive VM reuse and start empty in a fresh session", async () => {
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({
      _version: 0,
      mounts: [],
      guestOnlyDirectories: ["node_modules"],
    }),
  );
  const h = await setup();
  await h.emit("session_start");
  const provider = state.vmOptions[0].vfs?.mounts?.[process.cwd()];
  assert.ok(provider?.readFile && provider.writeFile);
  await provider.mkdir("/node_modules");
  await provider.writeFile("/node_modules/guest.txt", "guest dependency");
  await h.toggle();
  await h.toggle();
  assert.equal(state.starts, 1);
  assert.equal(
    (await provider.readFile("/node_modules/guest.txt")).toString(),
    "guest dependency",
  );
  await h.emit("session_shutdown");
  const fresh = await setup();
  await fresh.emit("session_start");
  const freshProvider = state.vmOptions[0].vfs?.mounts?.[process.cwd()];
  assert.ok(freshProvider?.readFile);
  await assert.rejects(
    freshProvider.readFile("/node_modules/guest.txt"),
    /ENOENT/,
  );
  await fresh.emit("session_shutdown");
});

test("shared parent renames stay allowed and moved host dependencies remain hidden", async () => {
  const cwd = process.cwd();
  const hostDirectory = path.join(cwd, "packages", "app", "node_modules");
  await mkdir(hostDirectory, { recursive: true });
  await writeFile(path.join(hostDirectory, "host.txt"), "host dependency");
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({
      _version: 0,
      mounts: [],
      guestOnlyDirectories: ["node_modules"],
    }),
  );
  const h = await setup();
  await h.emit("session_start");
  const provider = state.vmOptions[0].vfs?.mounts?.[cwd];
  assert.ok(provider?.readFile);
  await provider.rename("/packages/app", "/packages/moved");
  assert.equal(
    await readFile(
      path.join(cwd, "packages", "moved", "node_modules", "host.txt"),
      "utf8",
    ),
    "host dependency",
  );
  await assert.rejects(
    readFile(path.join(hostDirectory, "host.txt")),
    /ENOENT/,
  );
  await assert.rejects(
    provider.readFile("/packages/moved/node_modules/host.txt"),
    /ENOENT/,
  );
  assert.deepEqual(await provider.readdir("/packages/moved"), []);
  await h.emit("session_shutdown");
});

test("guest-only dependencies support package executable symlink lookup", async () => {
  const cwd = process.cwd();
  await mkdir(path.join(cwd, "node_modules"));
  await writeFile(
    path.join(cwd, "node_modules", "host.txt"),
    "host dependency",
  );
  await writeFile(
    path.join(state.configDir, "gondolin-rises.json"),
    JSON.stringify({
      _version: 0,
      mounts: [],
      guestOnlyDirectories: ["node_modules"],
    }),
  );
  const h = await setup();
  await h.emit("session_start");
  const provider = state.vmOptions[0].vfs?.mounts?.[cwd];
  assert.ok(provider?.readFile && provider.writeFile && provider.symlink);
  await provider.mkdir("/node_modules/pkg", { recursive: true });
  await provider.mkdir("/node_modules/.bin");
  await provider.writeFile("/node_modules/pkg/run.js", "#!/usr/bin/env node\n");
  await provider.symlink("../pkg/run.js", "/node_modules/.bin/fixture");
  assert.equal(
    (await provider.readFile("/node_modules/.bin/fixture")).toString(),
    "#!/usr/bin/env node\n",
  );
  assert.equal(
    await readFile(path.join(cwd, "node_modules", "host.txt"), "utf8"),
    "host dependency",
  );
  await assert.rejects(
    readFile(path.join(cwd, "node_modules", "pkg", "run.js")),
    /ENOENT/,
  );
  await h.emit("session_shutdown");
});
