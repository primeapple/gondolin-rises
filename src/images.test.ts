import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setup, state } from "./test-fixtures.ts";

test("configured images do not build on startup and warn until manually built", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );

  const h = await setup();
  assert.deepEqual(h.registeredFlags.get("update-gondolin-image"), {
    description: "Rebuild the custom Gondolin image",
    type: "boolean",
  });
  await h.emit("session_start");
  assert.equal(state.builds, 0);
  assert.equal(state.vmOptions[0].sandbox, undefined);
  assert.match(h.notices.join("\n"), /pi --update-gondolin-image/);
  await h.emit("session_shutdown");
});

test("manual image update installs a pointer and startup reuses it", async () => {
  state.gondolinVersion = "v0.13.0";
  await writeFile(
    state.configFile,
    JSON.stringify({ version: 0, image: { packages: ["git", "file"] } }),
  );

  const updater = await setup({ "update-gondolin-image": true });
  await updater.emit("session_start");
  assert.equal(state.builds, 1);
  assert.deepEqual(state.buildConfigs[0].alpine?.rootfsPackages, [
    "linux-virt",
    "bash",
    "git",
    "file",
  ]);
  assert.equal(state.starts, 0);
  assert.equal(updater.ctx.shutdown.mock.callCount(), 1);

  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
  const pointer = JSON.parse(
    await readFile(path.join(imagesDir, "active.json"), "utf8"),
  );
  const imagePath = path.join(imagesDir, pointer.imageKey, pointer.buildId);
  assert.ok(existsSync(imagePath));

  const next = await setup();
  await next.emit("session_start");
  assert.equal(state.builds, 0);
  assert.equal(state.vmOptions[0].sandbox?.imagePath, imagePath);
  assert.doesNotMatch(next.notices.join("\n"), /outdated|No custom/i);
  await next.emit("session_shutdown");

  const refresh = await setup({ "update-gondolin-image": true });
  await refresh.emit("session_start");
  assert.equal(state.builds, 1);
  const refreshed = JSON.parse(
    await readFile(path.join(imagesDir, "active.json"), "utf8"),
  );
  assert.notEqual(refreshed.buildId, pointer.buildId);
  assert.ok(existsSync(imagePath));
});

test("stale image stays active until update succeeds", async () => {
  state.gondolinVersion = "v0.13.0";
  await writeFile(
    state.configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
  const firstPointer = JSON.parse(
    await readFile(path.join(imagesDir, "active.json"), "utf8"),
  );
  const firstPath = path.join(
    imagesDir,
    firstPointer.imageKey,
    firstPointer.buildId,
  );

  await writeFile(
    state.configFile,
    JSON.stringify({ version: 0, image: { packages: ["ripgrep"] } }),
  );
  const stale = await setup();
  await stale.emit("session_start");
  assert.equal(state.builds, 0);
  assert.equal(state.vmOptions[0].sandbox?.imagePath, firstPath);
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
  assert.equal(state.builds, 1);
  const nextPointer = JSON.parse(
    await readFile(path.join(imagesDir, "active.json"), "utf8"),
  );
  assert.notEqual(nextPointer.buildId, firstPointer.buildId);
  assert.ok(existsSync(firstPath));
});

test("failed image update leaves active pointer unchanged", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const pointerPath = path.join(
    state.cacheHome,
    "gondolin-rises",
    "images",
    "active.json",
  );
  const activeBefore = await readFile(pointerPath, "utf8");
  const originalExitCode = process.exitCode;

  try {
    const updater = await setup({ "update-gondolin-image": true });
    state.failBuild = true;
    await updater.emit("session_start");
    assert.equal(updater.ctx.shutdown.mock.callCount(), 1);
    assert.equal(await readFile(pointerPath, "utf8"), activeBefore);
    assert.equal(process.exitCode, 1);
  } finally {
    state.failBuild = false;
    process.exitCode = originalExitCode;
  }
});

test("startup leaves unpointed legacy images untouched", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
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
  assert.equal(state.builds, 0);
  assert.equal(state.vmOptions[0].sandbox, undefined);
  assert.match(
    startup.notices.join("\n"),
    /No custom.*pi --update-gondolin-image/,
  );
  assert.equal(existsSync(path.join(imagesDir, "active.json")), false);
  assert.ok(existsSync(imagePath));
  await startup.emit("session_shutdown");
});

test("Gondolin version change warns and keeps active custom image", async () => {
  state.gondolinVersion = "v0.13.0";
  await writeFile(
    state.configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
  const pointer = JSON.parse(
    await readFile(path.join(imagesDir, "active.json"), "utf8"),
  );
  const imagePath = path.join(imagesDir, pointer.imageKey, pointer.buildId);

  state.gondolinVersion = "v0.14.0";
  const h = await setup();
  await h.emit("session_start");
  assert.equal(state.builds, 0);
  assert.equal(state.vmOptions[0].sandbox?.imagePath, imagePath);
  assert.match(h.notices.join("\n"), /outdated/);
  await h.emit("session_shutdown");
  state.gondolinVersion = "v0.13.0";
});

test("invalid active pointer blocks startup without cache repair", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
  await mkdir(imagesDir, { recursive: true });
  const pointerPath = path.join(imagesDir, "active.json");
  await writeFile(pointerPath, "{");
  const h = await setup();
  await assert.rejects(
    h.emit("session_start"),
    /active Gondolin image.*pi --update-gondolin-image/,
  );
  assert.equal(state.starts, 0);
  assert.equal(await readFile(pointerPath, "utf8"), "{");
});

test("unreadable active pointer blocks startup and remains untouched", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  const pointerPath = path.join(
    state.cacheHome,
    "gondolin-rises",
    "images",
    "active.json",
  );
  await mkdir(pointerPath, { recursive: true });
  const h = await setup();
  await assert.rejects(
    h.emit("session_start"),
    /active Gondolin image.*pi --update-gondolin-image/,
  );
  assert.equal(state.starts, 0);
  assert.ok(existsSync(pointerPath));
});

test("missing assets block startup without replacing active pointer", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
  const pointerPath = path.join(imagesDir, "active.json");
  const content = await readFile(pointerPath, "utf8");
  const pointer = JSON.parse(content);
  await rm(path.join(imagesDir, pointer.imageKey, pointer.buildId, "built"));
  const h = await setup();
  await assert.rejects(
    h.emit("session_start"),
    /active Gondolin image.*pi --update-gondolin-image/,
  );
  assert.equal(state.starts, 0);
  assert.equal(await readFile(pointerPath, "utf8"), content);
});

test("missing pointer does not promote new-layout builds", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
  const pointerPath = path.join(imagesDir, "active.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  await rm(pointerPath);
  const h = await setup();
  await h.emit("session_start");
  assert.equal(state.vmOptions[0].sandbox, undefined);
  assert.equal(state.builds, 0);
  assert.equal(existsSync(pointerPath), false);
  assert.ok(
    existsSync(path.join(imagesDir, pointer.imageKey, pointer.buildId)),
  );
  assert.match(h.notices.join("\n"), /No custom.*pi --update-gondolin-image/);
  await h.emit("session_shutdown");
});

test("empty packages bypass active cache and manual update", async () => {
  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
  await mkdir(imagesDir, { recursive: true });
  await writeFile(path.join(imagesDir, "active.json"), "broken");
  const h = await setup();
  await h.emit("session_start");
  assert.equal(state.vmOptions[0].sandbox, undefined);
  await h.emit("session_shutdown");
  const updater = await setup({ "update-gondolin-image": true });
  await updater.emit("session_start");
  assert.equal(state.builds, 0);
  assert.equal(state.starts, 0);
  assert.equal(updater.ctx.shutdown.mock.callCount(), 1);
  assert.equal(
    await readFile(path.join(imagesDir, "active.json"), "utf8"),
    "broken",
  );
});

test("pointer config validates before VM startup", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
  await mkdir(imagesDir, { recursive: true });
  const pointerPath = path.join(imagesDir, "active.json");
  const content = JSON.stringify({
    imageKey: "a".repeat(64),
    assetVersion: "v0.13.0",
    config: {},
  });
  await writeFile(pointerPath, content);
  const h = await setup();
  await assert.rejects(
    h.emit("session_start"),
    /Invalid Gondolin image pointer/,
  );
  assert.equal(state.starts, 0);
  assert.equal(await readFile(pointerPath, "utf8"), content);
});

test("equivalent config key order does not mark image stale or rewrite pointer", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({ version: 0, image: { packages: ["git"] } }),
  );
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const pointerPath = path.join(
    state.cacheHome,
    "gondolin-rises",
    "images",
    "active.json",
  );
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  const { arch, distro, alpine } = pointer.config;
  pointer.config = { alpine, distro, arch };
  const content = JSON.stringify(pointer);
  await writeFile(pointerPath, content);
  const h = await setup();
  await h.emit("session_start");
  assert.doesNotMatch(h.notices.join("\n"), /outdated|No custom/);
  assert.equal(await readFile(pointerPath, "utf8"), content);
  await h.emit("session_shutdown");
});
