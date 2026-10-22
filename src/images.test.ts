import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setup, state } from "./test-fixtures.ts";

test("configured images do not build on startup and warn until manually built", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({ arch: "x86_64", distro: "alpine" }),
  );

  const h = await setup();
  assert.deepEqual(h.registeredFlags.get("update-gondolin-image"), {
    description: "Rebuild the custom Gondolin image",
    type: "boolean",
  });
  await h.emit("session_start");
  assert.equal(state.builds, 0);
  assert.equal(state.vmOptions[0].sandbox, undefined);
  assert.ok(
    h.notices.includes(
      "Warning: Custom Gondolin image is outdated. Run `pi --update-gondolin-image --print` to rebuild it.",
    ),
  );
  await h.emit("session_shutdown");
});

test("manual image update installs a pointer and startup reuses it", async () => {
  state.gondolinVersion = "v0.13.0";
  await writeFile(
    state.configFile,
    JSON.stringify({
      arch: "x86_64",
      distro: "alpine",
      alpine: { version: "3.23.0", rootfsPackages: ["git", "file"] },
    }),
  );

  const updater = await setup({ "update-gondolin-image": true });
  await updater.emit("session_start");
  assert.equal(state.builds, 1);
  assert.deepEqual(state.buildConfigs[0].alpine?.rootfsPackages, [
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
  assert.equal(existsSync(imagePath), false);
});

test("stale image stays active until update succeeds", async () => {
  state.gondolinVersion = "v0.13.0";
  await writeFile(
    state.configFile,
    JSON.stringify({
      arch: "x86_64",
      distro: "alpine",
      alpine: { version: "3.23.0", rootfsPackages: ["git"] },
    }),
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
    JSON.stringify({
      arch: "x86_64",
      distro: "alpine",
      alpine: { version: "3.23.0", rootfsPackages: ["ripgrep"] },
    }),
  );
  const stale = await setup();
  await stale.emit("session_start");
  assert.equal(state.builds, 0);
  assert.equal(state.vmOptions[0].sandbox?.imagePath, firstPath);
  assert.match(
    stale.notices.join("\n"),
    /outdated.*pi --update-gondolin-image --print/i,
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
  assert.equal(existsSync(firstPath), false);
});

test("failed image update leaves active pointer unchanged", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({
      arch: "x86_64",
      distro: "alpine",
      alpine: { version: "3.23.0", rootfsPackages: ["git"] },
    }),
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
    const pointer = JSON.parse(activeBefore);
    assert.ok(
      existsSync(
        path.join(path.dirname(pointerPath), pointer.imageKey, pointer.buildId),
      ),
    );
    assert.equal(existsSync(state.buildOptions[0].outputDir), false);
    assert.equal(process.exitCode, 1);
  } finally {
    state.failBuild = false;
    process.exitCode = originalExitCode;
  }
});

test("startup leaves unpointed legacy images untouched", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({
      arch: "x86_64",
      distro: "alpine",
      alpine: { version: "3.23.0", rootfsPackages: ["git"] },
    }),
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
    /outdated.*pi --update-gondolin-image --print/,
  );
  assert.equal(existsSync(path.join(imagesDir, "active.json")), false);
  assert.ok(existsSync(imagePath));
  await startup.emit("session_shutdown");
});

test("Gondolin version change warns and keeps active custom image", async () => {
  state.gondolinVersion = "v0.13.0";
  await writeFile(
    state.configFile,
    JSON.stringify({
      arch: "x86_64",
      distro: "alpine",
      alpine: { version: "3.23.0", rootfsPackages: ["git"] },
    }),
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

test("invalid active pointer reports error and falls back without cache repair", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({
      arch: "x86_64",
      distro: "alpine",
      alpine: { version: "3.23.0", rootfsPackages: ["git"] },
    }),
  );
  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
  await mkdir(imagesDir, { recursive: true });
  const pointerPath = path.join(imagesDir, "active.json");
  await writeFile(pointerPath, "{");
  const h = await setup();
  await h.emit("session_start");
  assert.match(
    h.notices.join("\n"),
    /active Gondolin image.*pi --update-gondolin-image --print/,
  );
  assert.equal(state.vmOptions[0].sandbox, undefined);
  await h.emit("session_shutdown");
  assert.equal(await readFile(pointerPath, "utf8"), "{");
  assert.ok(
    h.ctx.ui.notify.mock.calls.some((call) => call.arguments[1] === "error"),
  );
});

test("unreadable active pointer reports error and uses default", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({
      arch: "x86_64",
      distro: "alpine",
      alpine: { version: "3.23.0", rootfsPackages: ["git"] },
    }),
  );
  const pointerPath = path.join(
    state.cacheHome,
    "gondolin-rises",
    "images",
    "active.json",
  );
  await mkdir(pointerPath, { recursive: true });
  const h = await setup();
  await h.emit("session_start");
  assert.match(
    h.notices.join("\n"),
    /active Gondolin image.*pi --update-gondolin-image --print/,
  );
  assert.equal(state.vmOptions[0].sandbox, undefined);
  await h.emit("session_shutdown");
  assert.ok(existsSync(pointerPath));
});

test("missing assets report error and use default without replacing active pointer", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({
      arch: "x86_64",
      distro: "alpine",
      alpine: { version: "3.23.0", rootfsPackages: ["git"] },
    }),
  );
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
  const pointerPath = path.join(imagesDir, "active.json");
  const content = await readFile(pointerPath, "utf8");
  const pointer = JSON.parse(content);
  await rm(path.join(imagesDir, pointer.imageKey, pointer.buildId, "built"));
  const h = await setup();
  await h.emit("session_start");
  assert.match(
    h.notices.join("\n"),
    /active Gondolin image.*pi --update-gondolin-image --print/,
  );
  assert.equal(state.vmOptions[0].sandbox, undefined);
  await h.emit("session_shutdown");
  assert.equal(await readFile(pointerPath, "utf8"), content);
});

test("missing pointer does not promote new-layout builds", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({
      arch: "x86_64",
      distro: "alpine",
      alpine: { version: "3.23.0", rootfsPackages: ["git"] },
    }),
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
  assert.match(h.notices.join("\n"), /outdated.*pi --update-gondolin-image --print/);
  await h.emit("session_shutdown");
});

test("missing config bypasses active cache and manual update", async () => {
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

test("invalid pointer config reports error and uses default", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({
      arch: "x86_64",
      distro: "alpine",
      alpine: { version: "3.23.0", rootfsPackages: ["git"] },
    }),
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
  await h.emit("session_start");
  assert.match(h.notices.join("\n"), /Invalid Gondolin image pointer/);
  assert.equal(state.vmOptions[0].sandbox, undefined);
  await h.emit("session_shutdown");
  assert.equal(await readFile(pointerPath, "utf8"), content);
});

test("equivalent config key order does not mark image stale or rewrite pointer", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({
      arch: "x86_64",
      distro: "alpine",
      alpine: { version: "3.23.0", rootfsPackages: ["git"] },
    }),
  );
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const pointerPath = path.join(
    state.cacheHome,
    "gondolin-rises",
    "images",
    "active.json",
  );
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  const { arch, distro, alpine } = pointer.sourceConfig;
  await writeFile(
    state.configFile,
    JSON.stringify({ alpine, distro, arch }, null, 2),
  );
  const content = await readFile(pointerPath, "utf8");
  const h = await setup();
  await h.emit("session_start");
  assert.doesNotMatch(h.notices.join("\n"), /outdated|No custom/);
  assert.equal(
    state.vmOptions[0].sandbox?.imagePath,
    path.join(path.dirname(pointerPath), pointer.imageKey, pointer.buildId),
  );
  assert.equal(await readFile(pointerPath, "utf8"), content);
  await h.emit("session_shutdown");
});

test("invalid config warns and keeps old image; invalid update fails without changing cache", async () => {
  await writeFile(state.configFile, '{"arch":"x86_64","distro":"alpine"}');
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
  const pointerPath = path.join(imagesDir, "active.json");
  const content = await readFile(pointerPath, "utf8");
  const pointer = JSON.parse(content);
  const imagePath = path.join(imagesDir, pointer.imageKey, pointer.buildId);
  await writeFile(state.configFile, "{");
  const h = await setup();
  await h.emit("session_start");
  assert.match(h.notices.join("\n"), /Invalid.*gondolin-build-config.json/);
  assert.ok(
    h.ctx.ui.notify.mock.calls.some((call) => call.arguments[1] === "warning"),
  );
  assert.equal(state.vmOptions[0].sandbox?.imagePath, imagePath);
  await h.emit("session_shutdown");
  const exitCode = process.exitCode;
  try {
    const updater = await setup({ "update-gondolin-image": true });
    await updater.emit("session_start");
    assert.equal(process.exitCode, 1);
    assert.equal(state.builds, 0);
    assert.equal(state.starts, 0);
    assert.equal(updater.ctx.shutdown.mock.callCount(), 1);
    assert.equal(await readFile(pointerPath, "utf8"), content);
  } finally {
    process.exitCode = exitCode;
  }
});

test("invalid config without old image warns and uses default", async () => {
  await writeFile(state.configFile, '{"arch":"wrong","distro":"alpine"}');
  const h = await setup();
  await h.emit("session_start");
  assert.match(h.notices.join("\n"), /Invalid.*gondolin-build-config.json/);
  assert.equal(state.vmOptions[0].sandbox, undefined);
  assert.equal(state.builds, 0);
  await h.emit("session_shutdown");
});

test("live Gondolin sessions block rebuild without changing active image", async () => {
  await writeFile(state.configFile, '{"arch":"x86_64","distro":"alpine"}');
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const pointerPath = path.join(
    state.cacheHome,
    "gondolin-rises",
    "images",
    "active.json",
  );
  const content = await readFile(pointerPath, "utf8");
  const exitCode = process.exitCode;
  try {
    state.sessions = [{ alive: false }, { alive: true }];
    const updater = await setup({ "update-gondolin-image": true });
    await updater.emit("session_start");
    assert.equal(process.exitCode, 1);
    assert.equal(state.builds, 0);
    assert.equal(state.starts, 0);
    assert.equal(updater.ctx.shutdown.mock.callCount(), 1);
    assert.equal(await readFile(pointerPath, "utf8"), content);
  } finally {
    process.exitCode = exitCode;
  }
});

test("runtime checks use cached image architecture and rootfs defaults, not current config", async () => {
  await writeFile(
    state.configFile,
    JSON.stringify({
      arch: "aarch64",
      distro: "alpine",
      runtimeDefaults: { rootfsMode: "readonly" },
    }),
  );
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  await writeFile(state.configFile, '{"arch":"x86_64","distro":"alpine"}');
  await rm(path.join(state.configDir, "bin", "qemu-system-x86_64"));
  await rm(path.join(state.configDir, "bin", "qemu-img"));
  const originalPath = process.env.PATH;
  process.env.PATH = path.join(state.configDir, "bin");
  try {
    const h = await setup();
    await h.emit("session_start");
    assert.ok(state.vmOptions[0].sandbox?.imagePath);
    assert.match(h.notices.join("\n"), /outdated/);
    await h.emit("session_shutdown");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("native build reports missing cpio and lz4 before building without requiring VM tools", async () => {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  await writeFile(state.configFile, JSON.stringify({ arch, distro: "alpine" }));
  for (const name of [
    "cpio",
    "lz4",
    "qemu-img",
    "qemu-system-x86_64",
    "qemu-system-aarch64",
  ]) {
    await rm(path.join(state.configDir, "bin", name));
  }
  const originalPath = process.env.PATH;
  const exitCode = process.exitCode;
  process.env.PATH = path.join(state.configDir, "bin");
  try {
    const h = await setup({ "update-gondolin-image": true });
    const errors: string[] = [];
    const error = console.error;
    console.error = (message: string) => {
      errors.push(message);
    };
    try {
      await h.emit("session_start");
    } finally {
      console.error = error;
    }
    assert.equal(state.builds, 0);
    assert.equal(process.exitCode, 1);
    assert.match(errors.join("\n"), /cpio.*lz4/s);
    assert.doesNotMatch(errors.join("\n"), /qemu/);
  } finally {
    process.env.PATH = originalPath;
    process.exitCode = exitCode;
  }
});

test("container builds accept upstream manifest rewrites and resolve config-relative paths", async () => {
  const config = {
    arch: "x86_64",
    distro: "alpine",
    container: { force: true, runtime: "docker" },
    postBuild: {
      copy: [{ src: "./source.txt", dest: "/tmp/source.txt" }],
      commands: ["echo done"],
    },
    env: { HELLO: "world" },
  };
  await writeFile(state.configFile, JSON.stringify(config));
  await writeFile(path.join(state.configDir, "source.txt"), "input");
  const updater = await setup({ "update-gondolin-image": true });
  await updater.emit("session_start");
  assert.equal(state.builds, 1);
  assert.deepEqual(state.buildConfigs[0], config);
  assert.equal(state.buildOptions[0].configDir, state.configDir);
  await writeFile(path.join(state.configDir, "source.txt"), "changed input");
  const h = await setup();
  await h.emit("session_start");
  assert.ok(state.vmOptions[0].sandbox?.imagePath);
  assert.doesNotMatch(h.notices.join("\n"), /outdated|Cannot load/);
  await h.emit("session_shutdown");
  const imagePath = state.vmOptions[0].sandbox?.imagePath;
  assert.ok(typeof imagePath === "string");
  await rm(state.configFile);
  const withoutConfig = await setup();
  await withoutConfig.emit("session_start");
  assert.equal(state.vmOptions[0].sandbox, undefined);
  assert.doesNotMatch(withoutConfig.notices.join("\n"), /outdated|Cannot load/);
  assert.ok(existsSync(imagePath));
  await withoutConfig.emit("session_shutdown");
});

test("failed asset verification retains old image and removes failed build output", async () => {
  await writeFile(state.configFile, '{"arch":"x86_64","distro":"alpine"}');
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const pointerPath = path.join(
    state.cacheHome,
    "gondolin-rises",
    "images",
    "active.json",
  );
  const content = await readFile(pointerPath, "utf8");
  const exitCode = process.exitCode;
  try {
    const updater = await setup({ "update-gondolin-image": true });
    state.failVerification = true;
    await updater.emit("session_start");
    assert.equal(process.exitCode, 1);
    assert.equal(await readFile(pointerPath, "utf8"), content);
    assert.equal(existsSync(state.buildOptions[0].outputDir), false);
  } finally {
    process.exitCode = exitCode;
  }
});

test("stale sessions allow rebuild; session-query failure blocks it", async () => {
  await writeFile(state.configFile, '{"arch":"x86_64","distro":"alpine"}');
  state.sessions = [{ alive: false }];
  const updater = await setup({ "update-gondolin-image": true });
  await updater.emit("session_start");
  assert.equal(state.builds, 1);
  const pointerPath = path.join(
    state.cacheHome,
    "gondolin-rises",
    "images",
    "active.json",
  );
  const content = await readFile(pointerPath, "utf8");
  const exitCode = process.exitCode;
  try {
    state.sessionError = true;
    const blocked = await setup({ "update-gondolin-image": true });
    await blocked.emit("session_start");
    assert.equal(process.exitCode, 1);
    assert.equal(state.builds, 0);
    assert.equal(await readFile(pointerPath, "utf8"), content);
  } finally {
    process.exitCode = exitCode;
  }
});

test("rebuild leaves legacy cache entries untouched even when active pointer uses legacy layout", async () => {
  await writeFile(state.configFile, '{"arch":"x86_64","distro":"alpine"}');
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
  const pointerPath = path.join(imagesDir, "active.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  const legacyPath = path.join(imagesDir, pointer.imageKey);
  for (const file of ["manifest.json", "built"]) {
    await rename(
      path.join(legacyPath, pointer.buildId, file),
      path.join(legacyPath, file),
    );
  }
  await rm(path.join(legacyPath, pointer.buildId), { recursive: true });
  delete pointer.buildId;
  await writeFile(pointerPath, JSON.stringify(pointer));
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const h = await setup();
  await h.emit("session_start");
  assert.ok(state.vmOptions[0].sandbox?.imagePath);
  assert.ok(existsSync(path.join(legacyPath, "built")));
  await h.emit("session_shutdown");
});

test("damaged cached assets report error and use default without cache repair", async () => {
  await writeFile(state.configFile, '{"arch":"x86_64","distro":"alpine"}');
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const pointerPath = path.join(
    state.cacheHome,
    "gondolin-rises",
    "images",
    "active.json",
  );
  const content = await readFile(pointerPath, "utf8");
  const h = await setup();
  state.failVerification = true;
  await h.emit("session_start");
  assert.equal(state.vmOptions[0].sandbox, undefined);
  assert.match(h.notices.join("\n"), /verification/i);
  assert.equal(await readFile(pointerPath, "utf8"), content);
  await h.emit("session_shutdown");
});
