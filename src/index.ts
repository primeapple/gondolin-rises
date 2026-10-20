/**
 * Pi + Gondolin Sandbox Example (pi extension)
 *
 * This extension overrides pi's built-in `read`/`write`/`edit`/`bash` tools so
 * they execute inside a Gondolin micro-VM instead of on the host.
 *
 * The directory you start `pi` in is mounted read-write at `/workspace` inside
 * the VM.
 *
 * How to run:
 *   1. Install dependencies for this repo (so imports resolve):
 *        pnpm install
 *   2. Ensure QEMU is installed (see the gondolin README "Quick Start")
 *   3. Start pi in the project you want to sandbox:
 *        cd /path/to/your/project
 *        pi -e /absolute/path/to/gondolin/host/examples/pi-gondolin.ts
 *
 * Notes:
 *   - The VM is started on `session_start` (and lazily if a tool is used before that)
 *   - User `!` commands are also executed inside the VM
 *   - Module resolution happens relative to this file, so keeping it inside the
 *     gondolin repo (or installing `@earendil-works/gondolin` next to it) is easiest
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

import {
  buildAssets,
  getAssetVersion,
  getDefaultBuildConfig,
  loadAssetManifest,
  loadGuestAssets,
  RealFSProvider,
  VM,
} from "@earendil-works/gondolin";
import { loadConfig } from "./config.ts";

const GUEST_WORKSPACE = "/workspace";

function shQuote(value: string): string {
  // POSIX shell quoting: wraps in single quotes and escapes internal quotes
  return `'${value.replace(/'/g, "'\\''")}'`;
}

type CachedImagePointer = {
  imageKey: string;
  buildId?: string;
  assetVersion: string | null;
  config: unknown;
};

function imagePath(imagesDir: string, pointer: CachedImagePointer): string {
  return path.join(
    imagesDir,
    pointer.imageKey,
    ...(pointer.buildId ? [pointer.buildId] : []),
  );
}

function isBuildConfig(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    isBuildConfig(pointer.config)
  );
}

function readImageConfig(dir: string): unknown | null {
  try {
    const manifest = loadAssetManifest(dir);
    if (!manifest || !isBuildConfig(manifest.config)) return null;
    loadGuestAssets(dir);
    return manifest.config;
  } catch {
    return null;
  }
}

async function readImagePointer(
  imagesDir: string,
): Promise<CachedImagePointer | null> {
  try {
    const value = JSON.parse(
      await readFile(path.join(imagesDir, "active.json"), "utf8"),
    );
    if (!isCachedImagePointer(value)) return null;
    const config = readImageConfig(imagePath(imagesDir, value));
    if (
      config === null ||
      JSON.stringify(config) !== JSON.stringify(value.config)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
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

async function findNewestCachedImage(
  imagesDir: string,
): Promise<CachedImagePointer | null> {
  const entries = await readdir(imagesDir, { withFileTypes: true }).catch(
    () => null,
  );
  if (!entries) return null;

  const candidates: Array<{
    pointer: CachedImagePointer;
    dir: string;
    modified: number;
  }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const imageKey = entry.name;
    const keyDir = path.join(imagesDir, imageKey);
    const addCandidate = async (dir: string, buildId?: string) => {
      try {
        candidates.push({
          pointer: {
            imageKey,
            ...(buildId ? { buildId } : {}),
            assetVersion: null,
            config: null,
          },
          dir,
          modified: (await stat(dir)).mtimeMs,
        });
      } catch {
        // Ignore cache entries removed during discovery.
      }
    };

    await addCandidate(keyDir);
    try {
      for (const child of await readdir(keyDir, { withFileTypes: true })) {
        if (child.isDirectory() && /^[a-f0-9-]+$/.test(child.name)) {
          await addCandidate(path.join(keyDir, child.name), child.name);
        }
      }
    } catch {
      // A legacy cache entry may not contain child builds.
    }
  }

  candidates.sort((a, b) => b.modified - a.modified);
  for (const candidate of candidates) {
    const config = readImageConfig(candidate.dir);
    if (config !== null) return { ...candidate.pointer, config };
  }
  return null;
}

function createBuildConfig(packages: string[]) {
  const buildConfig = getDefaultBuildConfig();
  buildConfig.alpine = {
    ...buildConfig.alpine,
    rootfsPackages: [
      ...new Set([...(buildConfig.alpine?.rootfsPackages ?? []), ...packages]),
    ],
  };
  return buildConfig;
}

function getImageCacheDir(): string {
  const cacheRoot =
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.resolve(cacheRoot, "gondolin-rises", "images");
}

function getImageKey(assetVersion: string, buildConfig: unknown): string {
  return createHash("sha256")
    .update(`${assetVersion}\0${JSON.stringify(buildConfig)}`)
    .digest("hex");
}

async function rebuildPackageImage(packages: string[]): Promise<string> {
  const buildConfig = createBuildConfig(packages);
  const assetVersion = getAssetVersion();
  const imageKey = getImageKey(assetVersion, buildConfig);
  const imagesDir = getImageCacheDir();
  const buildId = randomUUID();
  const outputDir = path.join(imagesDir, imageKey, buildId);

  await mkdir(path.dirname(outputDir), { recursive: true });
  await buildAssets(buildConfig, { outputDir });
  const config = readImageConfig(outputDir);
  if (
    config === null ||
    JSON.stringify(config) !== JSON.stringify(buildConfig)
  ) {
    throw new Error("Gondolin image build produced an incomplete cache entry");
  }
  const pointer = { imageKey, buildId, assetVersion, config };
  await writeImagePointer(imagesDir, pointer);
  return outputDir;
}

async function getStartupImage(
  packages: string[],
  notify: (message: string) => void,
): Promise<string | undefined> {
  if (packages.length === 0) return undefined;

  const buildConfig = createBuildConfig(packages);
  const assetVersion = getAssetVersion();
  const imagesDir = getImageCacheDir();
  let pointer = await readImagePointer(imagesDir);
  if (!pointer) {
    pointer = await findNewestCachedImage(imagesDir);
    if (pointer) {
      await writeImagePointer(imagesDir, pointer).catch(() => {});
    }
  }

  if (!pointer) {
    notify(
      "No custom Gondolin image cached. Run `pi --update-gondolin-image` to build one.",
    );
    return undefined;
  }

  if (
    pointer.assetVersion !== assetVersion ||
    JSON.stringify(pointer.config) !== JSON.stringify(buildConfig)
  ) {
    notify(
      "Custom Gondolin image is outdated. Run `pi --update-gondolin-image` to rebuild it.",
    );
  }
  return imagePath(imagesDir, pointer);
}

function toGuestPath(localCwd: string, localPath: string): string {
  // pi tools pass absolute local paths; map them into /workspace.
  const rel = path.relative(localCwd, localPath);
  if (rel === "") return GUEST_WORKSPACE;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  // Convert platform separators to POSIX for the Linux guest
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  return path.posix.join(GUEST_WORKSPACE, posixRel);
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
  return {
    readFile: async (p) => {
      return vm.fs.readFile(toGuestPath(localCwd, p));
    },
    access: async (p) => {
      await vm.fs.access(toGuestPath(localCwd, p), { mode: fsConstants.R_OK });
    },
    detectImageMimeType: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      try {
        // Run through the shell because `file` might live in `/usr/bin` depending on the image
        const r = await vm.exec([
          "/bin/sh",
          "-lc",
          `file --mime-type -b ${shQuote(guestPath)}`,
        ]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
          m,
        )
          ? m
          : null;
      } catch {
        return null;
      }
    },
  };
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
  return {
    // Use the VM filesystem API rather than a shell round-trip: it streams the
    // content, so there is no argv size limit and no quoting to get wrong.
    writeFile: async (p, content) => {
      const guestPath = toGuestPath(localCwd, p);
      await vm.fs.mkdir(path.posix.dirname(guestPath), { recursive: true });
      await vm.fs.writeFile(guestPath, content);
    },
    mkdir: async (dir) => {
      await vm.fs.mkdir(toGuestPath(localCwd, dir), { recursive: true });
    },
  };
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
  const r = createGondolinReadOps(vm, localCwd);
  const w = createGondolinWriteOps(vm, localCwd);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createGondolinBashOps(vm: VM, localCwd: string): BashOperations {
  return {
    // The host environment passed by pi is intentionally not forwarded: it
    // usually contains API keys and other credentials.  Configure secrets for
    // the guest with `httpHooks` (see docs/secrets.md) instead.
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const guestCwd = toGuestPath(localCwd, cwd);

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              ac.abort();
            }, timeout * 1000)
          : undefined;

      try {
        // `/bin/bash -lc` for a familiar environment (pipelines, expansions, etc.)
        const proc = vm.exec(["/bin/bash", "-lc", command], {
          cwd: guestCwd,
          signal: ac.signal,
          stdout: "pipe",
          stderr: "pipe",
        });

        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }

        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export default async function (pi: ExtensionAPI) {
  const config = await loadConfig(getAgentDir());
  const localCwd = process.cwd();

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  pi.registerFlag("update-gondolin-image", {
    description: "Rebuild the custom Gondolin image",
    type: "boolean",
  });

  let sandboxEnabled = true;
  let vm: VM | null = null;
  let vmStarting: Promise<VM> | null = null;
  let imageWarningShown = false;

  async function ensureVm(ctx?: ExtensionContext) {
    if (vm) return vm;
    if (vmStarting) return vmStarting;

    vmStarting = (async () => {
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: starting (mount ${GUEST_WORKSPACE})`,
        ),
      );

      const imagePath = await getStartupImage(
        config.image.packages,
        (message) => {
          if (imageWarningShown) return;
          imageWarningShown = true;
          ctx?.ui.notify(message, "warning");
        },
      );
      const created = await VM.create({
        ...(imagePath ? { sandbox: { imagePath } } : {}),
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
          },
        },
      });

      vm = created;
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: on (${localCwd} -> ${GUEST_WORKSPACE})`,
        ),
      );
      ctx?.ui.notify(
        `Gondolin VM ready. Host ${localCwd} mounted at ${GUEST_WORKSPACE}`,
        "info",
      );
      return created;
    })();

    try {
      return await vmStarting;
    } finally {
      vmStarting = null;
    }
  }

  pi.registerCommand("sandbox", {
    description: "Toggle Gondolin sandbox on or off",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      if (!sandboxEnabled) await ensureVm(ctx);
      sandboxEnabled = !sandboxEnabled;
      const status = sandboxEnabled
        ? "Gondolin: on"
        : "Gondolin: off — tools and ! commands run on host";
      ctx.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(sandboxEnabled ? "accent" : "warning", status),
      );
      ctx.ui.notify(status, sandboxEnabled ? "info" : "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("update-gondolin-image") === true) {
      try {
        if (config.image.packages.length === 0) {
          console.log("No custom image packages configured; nothing to build.");
        } else {
          const imagePath = await rebuildPackageImage(config.image.packages);
          console.log(`Updated custom Gondolin image: ${imagePath}`);
        }
      } catch (error) {
        process.exitCode = 1;
        console.error(
          `Failed to update custom Gondolin image: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        ctx.shutdown();
      }
      return;
    }

    // Start eagerly so the user sees errors early (missing qemu, etc.)
    if (sandboxEnabled) await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!vm) return;
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "Gondolin: stopping"),
    );
    try {
      await vm.close();
    } finally {
      vm = null;
      vmStarting = null;
    }
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxEnabled)
        return localRead.execute(id, params, signal, onUpdate);
      const activeVm = await ensureVm(ctx);
      const tool = createReadTool(localCwd, {
        operations: createGondolinReadOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxEnabled)
        return localWrite.execute(id, params, signal, onUpdate);
      const activeVm = await ensureVm(ctx);
      const tool = createWriteTool(localCwd, {
        operations: createGondolinWriteOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxEnabled)
        return localEdit.execute(id, params, signal, onUpdate);
      const activeVm = await ensureVm(ctx);
      const tool = createEditTool(localCwd, {
        operations: createGondolinEditOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxEnabled)
        return localBash.execute(id, params, signal, onUpdate);
      const activeVm = await ensureVm(ctx);
      const tool = createBashTool(localCwd, {
        operations: createGondolinBashOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // Run user `!` commands inside the VM too
  pi.on("user_bash", async (_event, ctx) => {
    if (!sandboxEnabled) return;
    const activeVm = await ensureVm(ctx);
    return { operations: createGondolinBashOps(activeVm, localCwd) };
  });

  // Replace the CWD line in the system prompt so the model sees /workspace
  pi.on("before_agent_start", async (event, ctx) => {
    if (!sandboxEnabled) return;
    await ensureVm(ctx);
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM, mounted from host: ${localCwd})`,
    );
    return { systemPrompt: modified };
  });
}
