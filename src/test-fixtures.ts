import assert from "node:assert/strict";
import type { BuildConfig, VMOptions } from "@earendil-works/gondolin";
import type {
  BashOperations,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, mock } from "node:test";

type FixtureState = {
  configDir: string;
  configFile: string;
  cacheHome: string;
  starts: number;
  closes: number;
  builds: number;
  buildConfigs: BuildConfig[];
  vmOptions: VMOptions[];
  gondolinVersion: string;
  failStart: boolean;
  failBuild: boolean;
  startBarrier: PromiseWithResolvers<void> | null;
  closeBarrier: PromiseWithResolvers<void> | null;
  vm: { close: () => Promise<void>; fs: object };
};

export const state: FixtureState = {
  configDir: "",
  configFile: "",
  cacheHome: "",
  starts: 0,
  closes: 0,
  builds: 0,
  buildConfigs: [],
  vmOptions: [],
  gondolinVersion: "v0.13.0",
  failStart: false,
  failBuild: false,
  startBarrier: null,
  closeBarrier: null,
  vm: { close: async () => {}, fs: {} },
};

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
beforeEach(async () => {
  state.configDir = await mkdtemp(path.join(os.tmpdir(), "gondolin-rises-"));
  state.configFile = path.join(state.configDir, "gondolin-rises.json");
  state.cacheHome = path.join(state.configDir, "cache");
  process.env.XDG_CACHE_HOME = state.cacheHome;
  await writeFile(state.configFile, JSON.stringify({ version: 0 }));
  state.gondolinVersion = "v0.13.0";
  state.startBarrier = null;
  state.closeBarrier = null;
  state.vm = {
    close: async () => {
      state.closes++;
      await state.closeBarrier?.promise;
    },
    fs: {},
  };
});
afterEach(async () => {
  await rm(state.configDir, { recursive: true, force: true });
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
});

type ToolOptions = { operations?: object };
function tool(name: string, cwd: string, options: ToolOptions = {}) {
  return {
    name,
    execute: async (...args: unknown[]) => ({
      name,
      cwd,
      operations: options.operations,
      args,
    }),
  };
}

const { validateBuildConfig } = await import("@earendil-works/gondolin");
mock.module("@earendil-works/pi-coding-agent", {
  namedExports: {
    ...Object.fromEntries(
      ["Read", "Write", "Edit", "Bash"].map((name) => [
        `create${name}Tool`,
        (cwd: string, options?: ToolOptions) =>
          tool(name.toLowerCase(), cwd, options),
      ]),
    ),
    getAgentDir: () => state.configDir,
  },
});
mock.module("@earendil-works/gondolin", {
  namedExports: {
    validateBuildConfig,
    RealFSProvider: class {},
    VM: {
      create: async (options: VMOptions) => {
        state.starts++;
        state.vmOptions.push(options);
        if (state.failStart) throw new Error("VM unavailable");
        await state.startBarrier?.promise;
        return state.vm;
      },
    },
    buildAssets: async (
      config: BuildConfig,
      options: { outputDir: string },
    ) => {
      state.builds++;
      state.buildConfigs.push(config);
      if (state.failBuild) throw new Error("image build failed");
      await mkdir(options.outputDir, { recursive: true });
      await writeFile(path.join(options.outputDir, "built"), "ok");
      await writeFile(
        path.join(options.outputDir, "manifest.json"),
        JSON.stringify({ config }),
      );
      return { outputDir: options.outputDir };
    },
    loadAssetManifest: (dir: string): unknown => {
      try {
        return JSON.parse(
          readFileSync(path.join(dir, "manifest.json"), "utf8"),
        );
      } catch {
        return null;
      }
    },
    loadGuestAssets: (dir: string) => {
      if (!existsSync(path.join(dir, "built")))
        throw new Error("incomplete guest image");
      return {};
    },
    getAssetVersion: () => state.gondolinVersion,
    getDefaultBuildConfig: (): BuildConfig => ({
      arch: "x86_64",
      distro: "alpine",
      alpine: { version: "3.23.0", rootfsPackages: ["linux-virt", "bash"] },
    }),
  },
});
const { default: extension } = await import("./index.ts");

function createContext(statuses: string[], notices: string[]) {
  return {
    waitForIdle: mock.fn(async () => {}),
    shutdown: mock.fn(),
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_key: string, text: string) => {
        statuses.push(text);
      },
      notify: (text: string) => {
        notices.push(text);
      },
    },
  };
}
type FixtureContext = ReturnType<typeof createContext>;
type EventResults = {
  session_start: undefined;
  session_shutdown: undefined;
  user_bash: { operations: BashOperations } | undefined;
  before_agent_start: { systemPrompt: string } | undefined;
};
type Handler = (
  event: object,
  ctx: FixtureContext,
) => Promise<EventResults[keyof EventResults]>;
type RoutedTool = {
  name: string;
  execute: (
    id: string,
    params: object,
    signal: AbortSignal | undefined,
    onUpdate: (() => void) | undefined,
    ctx: FixtureContext,
  ) => Promise<{ operations?: object; args: unknown[] }>;
};
type Command = {
  handler: (args: string, ctx: FixtureContext) => Promise<void>;
};
type Flag = { description: string; type: "boolean" };

export async function setup(flags: Partial<Record<string, boolean>> = {}) {
  state.starts = 0;
  state.closes = 0;
  state.builds = 0;
  state.buildConfigs = [];
  state.vmOptions = [];
  state.failStart = false;
  state.failBuild = false;
  const events = new Map<keyof EventResults, Handler>();
  const commands = new Map<string, Command>();
  const registeredFlags = new Map<string, Flag>();
  const tools = new Map<string, RoutedTool>();
  const statuses: string[] = [];
  const notices: string[] = [];
  const ctx = createContext(statuses, notices);
  // Host boundary supplies only APIs and context used by this extension.
  await extension({
    on: (name: keyof EventResults, handler: Handler) => {
      events.set(name, handler);
      return () => events.delete(name);
    },
    registerTool: (definition: RoutedTool) => {
      tools.set(definition.name, definition);
    },
    registerCommand: (name: string, command: Command) => {
      commands.set(name, command);
    },
    registerFlag: (name: string, flag: Flag) => {
      registeredFlags.set(name, flag);
    },
    getFlag: (name: string) => flags[name],
  } as unknown as ExtensionAPI);
  return {
    ctx,
    tools,
    statuses,
    notices,
    registeredFlags,
    emit: async <Name extends keyof EventResults>(
      name: Name,
      event: object = {},
    ): Promise<EventResults[Name]> => {
      const handler = events.get(name);
      assert.ok(handler, `Missing handler: ${name}`);
      return (await handler(event, ctx)) as EventResults[Name];
    },
    toggle: () => {
      const command = commands.get("sandbox");
      assert.ok(command);
      return command.handler("", ctx);
    },
  };
}

export const prompt = {
  systemPrompt: `Current working directory: ${process.cwd()}`,
};
export async function checkTools(
  harness: Awaited<ReturnType<typeof setup>>,
  sandboxed: boolean,
) {
  const signal = new AbortController().signal;
  const update = () => {};
  for (const definition of harness.tools.values()) {
    const params = { path: "example" };
    const result = await definition.execute(
      "id",
      params,
      signal,
      update,
      harness.ctx,
    );
    assert.equal(Boolean(result.operations), sandboxed, definition.name);
    assert.deepEqual(result.args, ["id", params, signal, update]);
  }
}
