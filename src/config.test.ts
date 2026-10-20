import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.ts";

test("config rejects missing, malformed, and unsupported versions", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gondolin-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const version of [undefined, null, "0", -1, 1]) {
    await t.test(`version ${JSON.stringify(version)}`, async () => {
      await writeFile(
        path.join(dir, "gondolin-rises.json"),
        JSON.stringify({ version }),
      );
      await assert.rejects(loadConfig(dir), /version must be 0/);
    });
  }
});

test("config normalizes known fields without rewriting unknown fields", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gondolin-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "gondolin-rises.json");
  const content = JSON.stringify({
    version: 0,
    extra: true,
    image: { packages: ["git"], extra: true },
  });
  await writeFile(file, content);
  assert.deepEqual(await loadConfig(dir), {
    version: 0,
    image: { packages: ["git"] },
  });
  assert.equal(await readFile(file, "utf8"), content);
});

test("config rejects invalid image/package shapes and malformed JSON", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gondolin-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const content of [
    "{",
    "[]",
    "null",
    '{"version":0,"image":[]}',
    '{"version":0,"image":{"packages":[1]}}',
  ]) {
    await writeFile(path.join(dir, "gondolin-rises.json"), content);
    await assert.rejects(loadConfig(dir));
  }
});
