import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getAssetVersion } from "@earendil-works/gondolin";
import { getStartupImage } from "./images.ts";

test("startup rejects asset directories without changing cache or hashing files", async (t) => {
  const imagesDir = await mkdtemp(path.join(os.tmpdir(), "image-validation-"));
  t.after(() => rm(imagesDir, { recursive: true, force: true }));
  const imageKey = "a".repeat(64);
  const imageDir = path.join(imagesDir, imageKey);
  await mkdir(imageDir);
  const config = { arch: "x86_64", distro: "alpine" } as const;
  const assets = {
    kernel: "vmlinuz-virt",
    initramfs: "initramfs.cpio.lz4",
    rootfs: "rootfs.ext4",
    krunKernel: "krun-kernel",
    krunInitrd: "krun-initrd",
  };
  await writeFile(
    path.join(imageDir, "manifest.json"),
    JSON.stringify({ config, assets, checksums: {} }),
  );
  const pointerPath = path.join(imagesDir, "active.json");
  const pointer = JSON.stringify({
    imageKey,
    assetVersion: getAssetVersion(),
    config,
  });
  await writeFile(pointerPath, pointer);
  for (const file of Object.values(assets)) {
    await writeFile(path.join(imageDir, file), "not a valid checksum");
  }
  const notices: string[] = [];
  const notify = (message: string) => notices.push(message);
  assert.equal(
    await getStartupImage(config, notify, undefined, imagesDir),
    imageDir,
  );
  assert.deepEqual(notices, []);

  for (const file of Object.values(assets)) {
    await t.test(file, async () => {
      const assetPath = path.join(imageDir, file);
      await rm(assetPath);
      await mkdir(assetPath);
      notices.length = 0;
      assert.equal(
        await getStartupImage(config, notify, undefined, imagesDir),
        undefined,
      );
      assert.match(
        notices.join("\n"),
        /Cannot load active Gondolin image.*pi --update-gondolin-image --print/,
      );
      assert.equal(await readFile(pointerPath, "utf8"), pointer);
      await rm(assetPath, { recursive: true });
      await writeFile(assetPath, "not a valid checksum");
    });
  }
});
