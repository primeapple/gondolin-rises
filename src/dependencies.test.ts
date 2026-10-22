import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertHostDependencies } from "./dependencies.ts";

test("reports every missing native build dependency without requiring QEMU", async () => {
  await assert.rejects(
    assertHostDependencies(
      { buildImage: true, arch: "aarch64" },
      { path: "", platform: "linux" },
    ),
    (error: Error) => {
      assert.match(error.message, /mke2fs.*e2fsprogs/);
      assert.match(error.message, /cpio.*apt install cpio/);
      assert.match(error.message, /lz4.*apt install lz4/);
      assert.doesNotMatch(error.message, /qemu/);
      return true;
    },
  );
});

test("checks only QEMU disk tools for krun runtime", async () => {
  await assert.rejects(
    assertHostDependencies(
      { arch: "x86_64", vmm: " KRUN " },
      { path: "", platform: "linux" },
    ),
    (error: Error) => {
      assert.doesNotMatch(error.message, /qemu-system/);
      assert.match(error.message, /qemu-img/);
      return true;
    },
  );
});

test("accepts executable dependencies found on PATH", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gondolin-deps-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ["mke2fs", "cpio", "lz4"]) {
    const executable = path.join(dir, name);
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
  }

  await assert.doesNotReject(() =>
    assertHostDependencies(
      { buildImage: true, arch: "aarch64" },
      { path: dir, platform: "linux" },
    ),
  );
});
