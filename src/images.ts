import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type BuildConfig,
  buildAssets,
  getAssetVersion,
  getDefaultBuildConfig,
  loadAssetManifest,
  loadGuestAssets,
  validateBuildConfig,
} from "@earendil-works/gondolin";

type CachedImagePointer = {
  imageKey: string;
  buildId?: string;
  assetVersion: string | null;
  config: BuildConfig;
};

function imagePath(imagesDir: string, pointer: CachedImagePointer): string {
  return path.join(
    imagesDir,
    pointer.imageKey,
    ...(pointer.buildId ? [pointer.buildId] : []),
  );
}

function isCachedImagePointer(value: unknown): value is CachedImagePointer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const pointer = value as Record<string, unknown>;
  return (
    typeof pointer.imageKey === "string" &&
    /^[a-f0-9]{64}$/.test(pointer.imageKey) &&
    (pointer.buildId === undefined ||
      (typeof pointer.buildId === "string" &&
        /^[a-f0-9-]+$/.test(pointer.buildId))) &&
    (typeof pointer.assetVersion === "string" ||
      pointer.assetVersion === null) &&
    validateBuildConfig(pointer.config)
  );
}

function readImageConfig(dir: string): BuildConfig {
  const manifest = loadAssetManifest(dir);
  if (!manifest || !validateBuildConfig(manifest.config)) {
    throw new Error("Missing or invalid Gondolin image manifest");
  }
  loadGuestAssets(dir);
  return manifest.config;
}

async function readImagePointer(
  imagesDir: string,
): Promise<CachedImagePointer | null> {
  let content: string;
  try {
    content = await readFile(path.join(imagesDir, "active.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  const value: unknown = JSON.parse(content);
  if (!isCachedImagePointer(value))
    throw new Error("Invalid Gondolin image pointer");
  const config = readImageConfig(imagePath(imagesDir, value));
  if (!isDeepStrictEqual(config, value.config)) {
    throw new Error("Active Gondolin image does not match its pointer");
  }
  return value;
}

async function writeImagePointer(
  imagesDir: string,
  pointer: CachedImagePointer,
): Promise<void> {
  await mkdir(imagesDir, { recursive: true });
  const pointerPath = path.join(imagesDir, "active.json");
  const tempPath = path.join(imagesDir, `.active-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(pointer)}\n`, { flag: "wx" });
    await rename(tempPath, pointerPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function createBuildConfig(packages: string[]): BuildConfig {
  const buildConfig = getDefaultBuildConfig();
  const alpine = buildConfig.alpine;
  if (!alpine)
    throw new Error(
      "Gondolin default build config must include Alpine settings",
    );
  buildConfig.alpine = {
    ...alpine,
    rootfsPackages: [
      ...new Set([...(alpine.rootfsPackages ?? []), ...packages]),
    ],
  };
  return buildConfig;
}

function getImageCacheDir(): string {
  const cacheRoot =
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.resolve(cacheRoot, "gondolin-rises", "images");
}

function getImageKey(assetVersion: string, buildConfig: BuildConfig): string {
  return createHash("sha256")
    .update(`${assetVersion}\0${JSON.stringify(buildConfig)}`)
    .digest("hex");
}

export async function rebuildPackageImage(
  packages: string[],
  imagesDir = getImageCacheDir(),
): Promise<string> {
  const buildConfig = createBuildConfig(packages);
  const assetVersion = getAssetVersion();
  const imageKey = getImageKey(assetVersion, buildConfig);
  const buildId = randomUUID();
  const outputDir = path.join(imagesDir, imageKey, buildId);

  await mkdir(path.dirname(outputDir), { recursive: true });
  await buildAssets(buildConfig, { outputDir });
  const config = readImageConfig(outputDir);
  if (!isDeepStrictEqual(config, buildConfig)) {
    throw new Error("Gondolin image build produced an incomplete cache entry");
  }
  const pointer = { imageKey, buildId, assetVersion, config };
  await writeImagePointer(imagesDir, pointer);
  return outputDir;
}

export async function getStartupImage(
  packages: string[],
  notify: (message: string) => void,
  imagesDir = getImageCacheDir(),
): Promise<string | undefined> {
  if (packages.length === 0) return undefined;

  const buildConfig = createBuildConfig(packages);
  const assetVersion = getAssetVersion();
  let pointer: CachedImagePointer | null;
  try {
    pointer = await readImagePointer(imagesDir);
  } catch (error) {
    throw new Error(
      `Cannot load active Gondolin image at ${path.join(imagesDir, "active.json")}. Run ` +
        "`pi --update-gondolin-image` to rebuild it. " +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }

  if (!pointer) {
    notify(
      "No custom Gondolin image cached. Run `pi --update-gondolin-image` to build one.",
    );
    return undefined;
  }

  if (
    pointer.assetVersion !== assetVersion ||
    !isDeepStrictEqual(pointer.config, buildConfig)
  ) {
    notify(
      "Custom Gondolin image is outdated. Run `pi --update-gondolin-image` to rebuild it.",
    );
  }
  return imagePath(imagesDir, pointer);
}
