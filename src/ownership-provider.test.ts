import assert from "node:assert/strict";
import { constants, type Stats, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MemoryProvider, RealFSProvider } from "@earendil-works/gondolin";
import { createOwnershipProvider } from "./ownership-provider.ts";

function statFixture(uid: number, gid: number) {
  return Object.freeze(
    Object.assign(statSync(import.meta.filename), { uid, gid }),
  );
}

test("mounted metadata reports matching host ownership as guest root without changing snapshot", async () => {
  const snapshot = statFixture(501, 20);
  const backend = new MemoryProvider();
  backend.stat = async () => snapshot;
  const provider = createOwnershipProvider(backend, 501, 20);

  const result = await provider.stat("/");
  assert.equal(result.uid, 0);
  assert.equal(result.gid, 0);
  assert.equal(snapshot.uid, 501);
  assert.equal(snapshot.gid, 20);
  assert.equal(Object.getPrototypeOf(result), Object.getPrototypeOf(snapshot));
  assert.deepEqual({ ...result, uid: 501, gid: 20 }, { ...snapshot });
  assert.equal(result.isFile(), true);
});

test("path, symlink and open-file metadata share ownership view and pass stat options", async () => {
  const snapshot = statFixture(501, 20);
  const options = { bigint: false };
  const backend = new MemoryProvider();
  let pathQueries = 0;
  let handleQueries = 0;
  const pathStat = (_path: string, received?: object) => {
    pathQueries++;
    assert.equal(received, options);
    return snapshot;
  };
  backend.stat = async (...args) => pathStat(...args);
  backend.statSync = pathStat;
  backend.lstat = async (...args) => pathStat(...args);
  backend.lstatSync = pathStat;
  backend.writeFileSync?.("/file", "contents");
  const open = backend.open.bind(backend);
  const openSync = backend.openSync.bind(backend);
  const handleStat = (received?: object) => {
    handleQueries++;
    assert.equal(received, options);
    return snapshot;
  };
  backend.open = async (...args) => {
    const handle = await open(...args);
    handle.stat = async (...args) => handleStat(...args);
    handle.statSync = handleStat;
    return handle;
  };
  backend.openSync = (...args) => {
    const handle = openSync(...args);
    handle.stat = async (...args) => handleStat(...args);
    handle.statSync = handleStat;
    return handle;
  };
  const provider = createOwnershipProvider(backend, 501, 20);
  const handle = await provider.open("/file", "r");
  const syncHandle = provider.openSync("/file", "r");
  try {
    for (const stats of [
      await provider.stat("/file", options),
      provider.statSync("/file", options),
      await provider.lstat("/file", options),
      provider.lstatSync("/file", options),
      await handle.stat(options),
      handle.statSync(options),
      await syncHandle.stat(options),
      syncHandle.statSync(options),
    ]) {
      assert.equal(stats.uid, 0);
      assert.equal(stats.gid, 0);
      assert.equal(stats.isFile(), true);
    }
    assert.equal(pathQueries, 4);
    assert.equal(handleQueries, 4);
    assert.equal(await handle.readFile("utf8"), "contents");
    assert.equal(syncHandle.readFileSync("utf8"), "contents");
  } finally {
    await handle.close();
    syncHandle.closeSync();
  }
});

test("ownership fields translate independently and preserve foreign owners", async () => {
  for (const [uid, gid, expectedUid, expectedGid] of [
    [501, 20, 0, 0],
    [501, 99, 0, 99],
    [99, 20, 99, 0],
    [99, 88, 99, 88],
    [0, 0, 0, 0],
  ]) {
    const backend = new MemoryProvider();
    backend.stat = async () => statFixture(uid, gid);
    const stats = await createOwnershipProvider(backend, 501, 20).stat("/");
    assert.equal(stats.uid, expectedUid);
    assert.equal(stats.gid, expectedGid);
  }
  const backend = new MemoryProvider();
  backend.stat = async () => statFixture(0, 0);
  const stats = await createOwnershipProvider(backend, 0, 0).stat("/");
  assert.equal(stats.uid, 0);
  assert.equal(stats.gid, 0);
});

test("bigint metadata retains shape and translates matching IDs independently", async () => {
  for (const [uid, gid, expectedUid, expectedGid] of [
    [501n, 20n, 0n, 0n],
    [501n, 99n, 0n, 99n],
    [99n, 20n, 99n, 0n],
    [99n, 88n, 99n, 88n],
  ]) {
    const snapshot = Object.freeze(
      Object.assign(statSync(import.meta.filename, { bigint: true }), {
        uid,
        gid,
      }),
    );
    const backend = new MemoryProvider();
    // Gondolin types say Stats even when backend supports bigint stat options.
    backend.stat = async () => snapshot as unknown as Stats;
    const stats = await createOwnershipProvider(backend, 501, 20).stat("/", {
      bigint: true,
    });
    assert.equal(stats.uid, expectedUid);
    assert.equal(stats.gid, expectedGid);
    assert.equal(stats.isFile(), true);
    assert.equal(Object.getPrototypeOf(stats), Object.getPrototypeOf(snapshot));
    assert.deepEqual({ ...stats, uid, gid }, { ...snapshot });
  }
});

test("real mount keeps metadata, symlink types and host ownership unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ownership-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = new RealFSProvider(root);
  await backend.writeFile?.("/file", "contents", { mode: 0o640 });
  await backend.symlink("file", "/alias");
  const host = await backend.stat("/file");
  const provider = createOwnershipProvider(backend, host.uid, host.gid);
  const handle = await provider.open("/file", "r");
  const syncHandle = provider.openSync("/file", "r");
  try {
    for (const stats of [
      await provider.stat("/file"),
      provider.statSync("/alias"),
      await provider.lstat("/file"),
      provider.lstatSync("/file"),
      await handle.stat(),
      syncHandle.statSync(),
    ]) {
      assert.equal(stats.uid, 0);
      assert.equal(stats.gid, 0);
      assert.deepEqual({ ...stats, uid: host.uid, gid: host.gid }, { ...host });
      assert.equal(stats.isFile(), true);
    }
    assert.equal((await provider.lstat("/alias")).isSymbolicLink(), true);
    assert.equal(provider.lstatSync("/alias").isSymbolicLink(), true);
    assert.equal((await provider.stat("/")).isDirectory(), true);
    assert.equal((await provider.stat("/file", { bigint: true })).size, 8n);
    assert.equal(handle.statSync({ bigint: true }).uid, 0n);
    assert.deepEqual(await backend.stat("/file"), host);
  } finally {
    await handle.close();
    syncHandle.closeSync();
  }
  await assert.rejects(handle.stat(), /EBADF/);
  assert.throws(() => syncHandle.statSync(), /EBADF/);
});

test("mount forwards filesystem operations, capabilities and errors to original provider", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ownership-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = new RealFSProvider(root);
  const host = backend.statSync("/");
  const provider = createOwnershipProvider(backend, host.uid, host.gid);
  assert.equal(provider.readonly, backend.readonly);
  assert.equal(provider.supportsSymlinks, backend.supportsSymlinks);
  assert.equal(provider.supportsWatch, backend.supportsWatch);
  assert.ok(provider.writeFile && provider.readFile && provider.chmod);
  assert.ok(provider.symlink && provider.readlink && provider.realpath);
  assert.ok(provider.access && provider.copyFile && provider.link);
  await provider.mkdir("/dir");
  await provider.writeFile("/dir/file", "first");
  const handle = await provider.open("/dir/file", "r+");
  await handle.writeFile("other");
  await handle.truncate(4);
  await handle.close();
  assert.equal((await provider.readFile("/dir/file")).toString(), "othe");
  await provider.chmod("/dir/file", 0o751);
  assert.equal(backend.statSync("/dir/file").mode & 0o777, 0o751);
  await provider.access("/dir/file", constants.R_OK);
  const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
  const access = t.mock.method(
    backend,
    "access",
    async function (this: RealFSProvider, entryPath: string, mode?: number) {
      assert.equal(this, backend);
      assert.equal(entryPath, "/dir/file");
      assert.equal(mode, constants.W_OK);
      throw denied;
    },
  );
  await assert.rejects(
    provider.access("/dir/file", constants.W_OK),
    (error) => error === denied,
  );
  access.mock.restore();
  await provider.rename("/dir/file", "/dir/renamed");
  await provider.copyFile("/dir/renamed", "/dir/copy");
  await provider.link("/dir/renamed", "/dir/hardlink");
  await provider.symlink("renamed", "/dir/alias");
  assert.equal(await provider.readlink("/dir/alias"), "renamed");
  assert.equal(await provider.realpath("/dir/alias"), "/dir/renamed");
  assert.equal((await provider.readFile("/dir/alias")).toString(), "othe");
  const entries = await provider.readdir("/dir", { withFileTypes: true });
  assert.ok(
    entries.some(
      (entry) => typeof entry !== "string" && entry.isSymbolicLink(),
    ),
  );
  for (const name of ["alias", "renamed", "copy", "hardlink"]) {
    await provider.unlink(`/dir/${name}`);
  }
  await provider.rmdir("/dir");
  assert.deepEqual(await backend.readdir("/"), []);
  await assert.rejects(provider.stat("/missing"), { code: "ENOENT" });
  await assert.rejects(provider.open("/missing", "r"), { code: "ENOENT" });
  assert.equal(
    provider.statSync("/missing", { throwIfNoEntry: false }),
    undefined,
  );
  assert.equal(
    provider.lstatSync("/missing", { throwIfNoEntry: false }),
    undefined,
  );

  provider.mkdirSync("/sync");
  const syncHandle = provider.openSync("/sync/file", "w+");
  syncHandle.writeFileSync("synchronous");
  syncHandle.truncateSync(4);
  const buffer = Buffer.alloc(4);
  assert.equal(syncHandle.readSync(buffer, 0, 4, 0), 4);
  assert.equal(buffer.toString(), "sync");
  syncHandle.closeSync();
  provider.renameSync("/sync/file", "/sync/renamed");
  provider.unlinkSync("/sync/renamed");
  provider.rmdirSync("/sync");
  assert.deepEqual(backend.readdirSync("/"), []);

  const memory = new MemoryProvider();
  const minimal = createOwnershipProvider(memory, 501, 20);
  assert.equal("statfs" in minimal, "statfs" in memory);
  assert.equal(minimal.statfs, memory.statfs);
  memory.setReadOnly();
  assert.equal(minimal.readonly, true);
  await assert.rejects(minimal.mkdir("/blocked"), { code: "EROFS" });
});
