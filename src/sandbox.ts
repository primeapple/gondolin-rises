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
  configError?: string,
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
      const created = await VM.create({
        ...(imagePath ? { sandbox: { imagePath } } : {}),
        vfs: {
          mounts: {
            [mountPath]: new RealFSProvider(localCwd),
          },
        },
      });

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
