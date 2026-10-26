import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { mock, test } from "node:test";

let cleanupPath: string | undefined;
const cleanupError = new Error("cleanup denied", { cause: "EACCES" });
mock.module("node:fs/promises", {
  namedExports: {
    ...fs,
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === cleanupPath) throw cleanupError;
      return fs.rm(...args);
    },
  },
});
const { setup, state } = await import("./test-fixtures.ts");

test("image update reports success and keeps new image active when old image cleanup fails", async (t) => {
  const originalExitCode = process.exitCode;
  t.after(() => {
    cleanupPath = undefined;
    process.exitCode = originalExitCode;
  });
  await fs.writeFile(state.configFile, '{"arch":"x86_64","distro":"alpine"}');
  await (await setup({ "update-gondolin-image": true })).emit("session_start");
  const imagesDir = path.join(state.cacheHome, "gondolin-rises", "images");
  const pointerPath = path.join(imagesDir, "active.json");
  const previous = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  cleanupPath = path.join(imagesDir, previous.imageKey, previous.buildId);

  const log = mock.method(console, "log", () => {});
  const warn = mock.method(console, "warn", () => {});
  const error = mock.method(console, "error", () => {});
  process.exitCode = 0;
  const updater = await setup({ "update-gondolin-image": true });
  await updater.emit("session_start");
  assert.equal(process.exitCode, 0);
  assert.equal(error.mock.callCount(), 0);
  assert.equal(updater.ctx.shutdown.mock.callCount(), 1);
  const active = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  assert.notEqual(active.buildId, previous.buildId);
  const activePath = path.join(imagesDir, active.imageKey, active.buildId);
  assert.match(log.mock.calls[0].arguments[0], /Updated custom Gondolin image:/);
  assert.ok(log.mock.calls[0].arguments[0].includes(activePath));
  assert.equal(warn.mock.callCount(), 1);
  const warning = warn.mock.calls[0].arguments[0];
  assert.match(warning, /Warning:.*active.*cleanup.*cleanup denied/);
  assert.ok(warning.includes(cleanupPath));
  assert.equal(await fs.readFile(path.join(cleanupPath, "built"), "utf8"), "ok");

  const startup = await setup();
  await startup.emit("session_start");
  assert.equal(state.vmOptions[0].sandbox?.imagePath, activePath);
  await startup.emit("session_shutdown");
});
