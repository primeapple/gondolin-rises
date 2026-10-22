import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type BuildConfig,
  buildAssets,
  getAssetVersion,
  loadAssetManifest,
  loadGuestAssets,
  validateBuildConfig,
  verifyAssets,
} from "@earendil-works/gondolin";

type CachedImagePointer = {
  imageKey: string;
  buildId?: string;
  assetVersion: string | null;
  config: BuildConfig;
  sourceConfig?: BuildConfig;
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
    validateBuildConfig(pointer.config) &&
    (pointer.sourceConfig === undefined ||
      validateBuildConfig(pointer.sourceConfig))
  );
}

function readImageConfig(dir: string): BuildConfig {
  const manifest = loadAssetManifest(dir);
  if (!manifest || !validateBuildConfig(manifest.config)) {
    throw new Error("Missing or invalid Gondolin image manifest");
  }
  loadGuestAssets(dir);
  if (!verifyAssets(dir))
    throw new Error("Gondolin image failed asset verification");
  return manifest.config;
}

async function readStoredPointer(
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
  return value;
}

async function readImagePointer(
  imagesDir: string,
): Promise<CachedImagePointer | null> {
  const value = await readStoredPointer(imagesDir);
  if (!value) return null;
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

export async function rebuildImage(
  buildConfig: BuildConfig,
  configDir: string,
  imagesDir = getImageCacheDir(),
): Promise<string> {
  const assetVersion = getAssetVersion();
  const imageKey = getImageKey(assetVersion, buildConfig);
  const buildId = randomUUID();
  const outputDir = path.join(imagesDir, imageKey, buildId);

  const previous = await readStoredPointer(imagesDir).catch(() => null);
  await mkdir(path.dirname(outputDir), { recursive: true });
  try {
    await buildAssets(buildConfig, { outputDir, configDir });
    const config = readImageConfig(outputDir);
    const pointer = {
      imageKey,
      buildId,
      assetVersion,
      config,
      sourceConfig: buildConfig,
    };
    await writeImagePointer(imagesDir, pointer);
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
  if (previous?.buildId)
    await rm(imagePath(imagesDir, previous), { recursive: true, force: true });
  return outputDir;
}

export async function getStartupImage(
  buildConfig: BuildConfig | null,
  notify: (message: string, level: "warning" | "error") => void,
  configError?: string,
  imagesDir = getImageCacheDir(),
): Promise<string | undefined> {
  if (!buildConfig && !configError) return undefined;
  if (configError)
    notify(
      `Warning: ${configError}. Fix gondolin-build-config.json before rebuilding.`,
      "warning",
    );

  const assetVersion = getAssetVersion();
  let pointer: CachedImagePointer | null;
  try {
    pointer = await readImagePointer(imagesDir);
  } catch (error) {
    notify(
      `Cannot load active Gondolin image at ${path.join(imagesDir, "active.json")}. Run ` +
        "`pi --update-gondolin-image --print` to rebuild it. " +
        (error instanceof Error ? error.message : String(error)),
      "error",
    );
    pointer = null;
  }

  if (!pointer) {
    if (buildConfig)
      notify(
        "Warning: Custom Gondolin image is outdated. Run `pi --update-gondolin-image --print` to rebuild it.",
        "warning",
      );
    return undefined;
  }

  if (
    buildConfig &&
    (pointer.assetVersion !== assetVersion ||
      !isDeepStrictEqual(pointer.sourceConfig ?? pointer.config, buildConfig))
  ) {
    notify(
      "Warning: Custom Gondolin image is outdated. Run `pi --update-gondolin-image --print` to rebuild it.",
      "warning",
    );
  }
  return imagePath(imagesDir, pointer);
}
