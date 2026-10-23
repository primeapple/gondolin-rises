import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadUserConfig } from "./user-config.ts";

test("missing user config returns null without creating files", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gondolin-user-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await loadUserConfig(dir), null);
  assert.deepEqual(await readdir(dir), []);
});

test("user config resolves relative mount directories and stays unchanged", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gondolin-user-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mount = path.join(dir, ".agents");
  await mkdir(mount);
  const file = path.join(dir, "gondolin-rises.json");
  const content = '{"_version":0,"mounts":[".agents"]}\n';
  await writeFile(file, content);

  const config = await loadUserConfig(dir);
  assert.deepEqual(config, { _version: 0, mounts: [mount] });
  assert.equal(await readFile(file, "utf8"), content);
});

test("user config keeps in-home symlink mount path unchanged", async (t) => {
  const dir = await mkdtemp(path.join(os.homedir(), "gondolin-user-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "shared");
  await mkdir(target);
  const link = path.join(dir, "shared-link");
  await symlink(target, link);
  await writeFile(
    path.join(dir, "gondolin-rises.json"),
    JSON.stringify({ _version: 0, mounts: ["shared-link"] }),
  );
  assert.deepEqual(await loadUserConfig(dir), {
    _version: 0,
    mounts: [link],
  });
});

test("user config rejects invalid version, paths, and mount targets", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gondolin-user-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const regularFile = path.join(dir, "file.txt");
  await writeFile(regularFile, "not a directory");
  const file = path.join(dir, "gondolin-rises.json");
  for (const value of [
    "{",
    "[]",
    "null",
    "{}",
    '{"_version":1,"mounts":[]}',
    '{"_version":0}',
    '{"_version":0,"mounts":".agents"}',
    JSON.stringify({ _version: 0, mounts: ["file.txt"] }),
    JSON.stringify({ _version: 0, mounts: [regularFile] }),
    JSON.stringify({ _version: 0, mounts: ["missing"] }),
    JSON.stringify({ _version: 0, mounts: [path.parse(dir).root] }),
  ]) {
    await writeFile(file, value);
    await assert.rejects(loadUserConfig(dir), /Invalid.*gondolin-rises.json/);
  }
});
