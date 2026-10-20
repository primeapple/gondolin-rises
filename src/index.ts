/** Run pi file and shell tools inside Gondolin; mount host project at /workspace. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { rebuildPackageImage } from "./images.ts";
import {
  GUEST_WORKSPACE,
  createGondolinBashOps,
  createGondolinEditOps,
  createGondolinReadOps,
  createGondolinWriteOps,
} from "./operations.ts";
import { createSandbox } from "./sandbox.ts";

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
  const { ensureVm, close } = createSandbox(localCwd, config.image.packages);

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
    await close(ctx);
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
