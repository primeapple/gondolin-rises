import assert from "node:assert/strict";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { guestWorkspacePath } from "./operations.ts";
import { checkTools, prompt, setup, state } from "./test-fixtures.ts";

async function waitForVmStart() {
  const deadline = Date.now() + 1000;
  while (state.starts === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(state.starts, 1);
}

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

  const result = await h.emit("before_agent_start", {
    systemPrompt: `Current working directory: ${cwd}`,
  });
  assert.equal(
    result?.systemPrompt,
    `Current working directory: ${cwd} (Gondolin VM, mounted from host: ${cwd})`,
  );
  await h.emit("session_shutdown");
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
