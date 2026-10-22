import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.ts";

test("missing build config returns null without creating files", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gondolin-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await loadConfig(dir), null);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(await loadConfig(path.join(dir, "absent")), null);
});

test("upstream build config loads unchanged and leaves file untouched", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gondolin-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = {
    arch: "aarch64",
    distro: "alpine",
    postBuild: { copy: [{ src: "./tool", dest: "/usr/bin/tool" }] },
    runtimeDefaults: { rootfsMode: "readonly" },
  };
  const file = path.join(dir, "gondolin-build-config.json");
  const content = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(file, content);
  assert.deepEqual(await loadConfig(dir), config);
  assert.equal(await readFile(file, "utf8"), content);
});

test("upstream validation rejects malformed JSON and invalid config fields", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gondolin-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const content of [
    "{",
    "[]",
    "null",
    "{}",
    '{"arch":"invalid","distro":"alpine"}',
    '{"arch":"x86_64","distro":"alpine","alpine":{"version":"3.23.0","rootfsPackages":[1]}}',
    '{"arch":"x86_64","distro":"alpine","postBuild":{"copy":[{"src":"file","dest":"relative"}]}}',
  ]) {
    await writeFile(path.join(dir, "gondolin-build-config.json"), content);
    await assert.rejects(
      loadConfig(dir),
      /Invalid.*gondolin-build-config.json/,
    );
  }
});
