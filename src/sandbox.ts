import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type BuildConfig,
  RealFSProvider,
  VM,
  getDefaultBuildConfig,
  loadAssetManifest,
} from "@earendil-works/gondolin";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertHostDependencies } from "./dependencies.ts";
import { getStartupImage } from "./images.ts";
import { guestWorkspacePath } from "./operations.ts";

export function createSandbox(
  localCwd: string,
  config: BuildConfig | null,
  configuredMounts: readonly string[],
  configError?: string,
  mountsError?: string,
) {
  let vm: VM | null = null;
  let vmStarting: Promise<VM> | null = null;
  const imageNoticesShown = new Set<string>();
  let stopped = false;
  let closing: Promise<void> | null = null;

  async function ensureVm(ctx?: ExtensionContext) {
    if (stopped) throw new Error("Gondolin sandbox shut down");
    if (vm) return vm;
    if (vmStarting) return vmStarting;

    vmStarting = (async () => {
      if (mountsError) {
        ctx?.ui.notify(mountsError, "error");
        throw new Error(mountsError);
      }
      const mountPath = guestWorkspacePath(localCwd);
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("accent", `Gondolin: starting (mount ${mountPath})`),
      );

      const imagePath = await getStartupImage(
        config,
        (message, level) => {
          if (imageNoticesShown.has(message)) return;
          imageNoticesShown.add(message);
          ctx?.ui.notify(message, level);
        },
        configError,
      );
      const runtimeImagePath = imagePath ?? process.env.GONDOLIN_GUEST_DIR;
      const manifest = runtimeImagePath
        ? loadAssetManifest(runtimeImagePath)
        : null;
      try {
        await assertHostDependencies({
          arch: manifest?.config.arch ?? getDefaultBuildConfig().arch,
          rootfsMode: manifest?.runtimeDefaults?.rootfsMode,
          vmm: process.env.GONDOLIN_VMM,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx?.ui.notify(message, "error");
        throw error;
      }

      if (stopped) throw new Error("Gondolin sandbox shut down");
      let mounts: Record<string, RealFSProvider>;
      try {
        const allowedRoots = [os.homedir(), os.tmpdir()].map((root) =>
          realpathSync(root),
        );
        mounts = Object.fromEntries(
          [localCwd, ...configuredMounts].map((hostPath) => {
            const provider = new RealFSProvider(hostPath);
            const allowed = allowedRoots.some((root) => {
              const relative = path.relative(root, provider.rootPath);
              return (
                relative !== ".." &&
                !relative.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relative)
              );
            });
            if (!allowed) {
              throw new Error(
                `Cannot mount ${hostPath}: resolves outside user home and temp directory (${allowedRoots.join(", ")}). Use a directory inside home or temp.`,
              );
            }
            return [guestWorkspacePath(hostPath), provider];
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx?.ui.notify(message, "error");
        throw error;
      }
      const homePath = guestWorkspacePath(os.homedir());
      const created = await VM.create({
        ...(imagePath ? { sandbox: { imagePath } } : {}),
        env: { HOME: homePath },
        vfs: { mounts },
      });

      try {
        await created.fs.mkdir(homePath, { recursive: true });
      } catch (error) {
        await created.close();
        throw error;
      }
      vm = created;
      if (stopped) throw new Error("Gondolin sandbox shut down");
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("accent", `Gondolin: on (mount ${mountPath})`),
      );
      ctx?.ui.notify(
        `Gondolin VM ready. Host CWD mounted at same guest path: ${mountPath}`,
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

  function close(ctx?: ExtensionContext): Promise<void> {
    stopped = true;
    closing ??= (async () => {
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("muted", "Gondolin: stopping"),
      );
      // Startup errors belong to the caller; any created VM still needs cleanup.
      await vmStarting?.catch(() => {});
      const activeVm = vm;
      vm = null;
      if (activeVm) await activeVm.close();
    })();
    return closing;
  }

  return { ensureVm, close };
}
