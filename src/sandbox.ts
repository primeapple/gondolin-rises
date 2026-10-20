import { RealFSProvider, VM } from "@earendil-works/gondolin";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getStartupImage } from "./images.ts";
import { GUEST_WORKSPACE } from "./operations.ts";

export function createSandbox(localCwd: string, packages: string[]) {
  let vm: VM | null = null;
  let vmStarting: Promise<VM> | null = null;
  let imageWarningShown = false;
  let stopped = false;
  let closing: Promise<void> | null = null;

  async function ensureVm(ctx?: ExtensionContext) {
    if (stopped) throw new Error("Gondolin sandbox shut down");
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

      const imagePath = await getStartupImage(packages, (message) => {
        if (imageWarningShown) return;
        imageWarningShown = true;
        ctx?.ui.notify(message, "warning");
      });
      if (stopped) throw new Error("Gondolin sandbox shut down");
      const created = await VM.create({
        ...(imagePath ? { sandbox: { imagePath } } : {}),
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
          },
        },
      });

      vm = created;
      if (stopped) throw new Error("Gondolin sandbox shut down");
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
