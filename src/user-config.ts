import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ToggleHotkey = Parameters<ExtensionAPI["registerShortcut"]>[0];

function isToggleHotkey(value: unknown): value is ToggleHotkey {
  if (typeof value !== "string") return false;
  const match = /^((?:(?:ctrl|shift|alt|super)\+)*)(.+)$/.exec(value);
  if (!match) return false;
  const modifiers = match[1].split("+").filter(Boolean);
  if (new Set(modifiers).size !== modifiers.length) return false;
  const key = match[2];
  return (
    /^[a-z0-9]$/.test(key) ||
    (key.length === 1 && "`-=\\[];',./!@#$%^&*()_+|~{}:<>?".includes(key)) ||
    /^(?:escape|esc|enter|return|tab|space|backspace|delete|insert|clear|home|end|pageUp|pageDown|up|down|left|right|f[1-9]|f1[0-2])$/.test(
      key,
    )
  );
}

/** Parsed user config; paths resolved against the agent config directory. */
export interface UserSecret {
  readonly hostEnv: string;
  readonly hosts?: readonly string[];
}

export interface UserConfig {
  readonly _version: 0;
  readonly mounts: readonly string[];
  readonly guestOnlyDirectories?: readonly string[];
  readonly sandboxAgentsFile?: string;
  readonly toggleHotkey?: ToggleHotkey;
  readonly secrets?: Readonly<Record<string, UserSecret>>;
}

export async function loadUserConfig(
  agentDir: string,
): Promise<UserConfig | null> {
  const configPath = path.join(agentDir, "gondolin-rises.json");
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw new Error(`Cannot read ${configPath}`, { cause: error });
  }

  try {
    const config: unknown = JSON.parse(content);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("expected a JSON object");
    }
    const {
      _version,
      mounts,
      guestOnlyDirectories,
      sandboxAgentsFile,
      secrets,
      toggleHotkey,
    } = config as {
      _version?: unknown;
      mounts?: unknown;
      guestOnlyDirectories?: unknown;
      sandboxAgentsFile?: unknown;
      secrets?: unknown;
      toggleHotkey?: unknown;
    };
    if (_version !== 0) throw new Error("_version must be 0");
    if (!Array.isArray(mounts)) throw new Error("mounts must be an array");
    if (
      guestOnlyDirectories !== undefined &&
      (!Array.isArray(guestOnlyDirectories) ||
        guestOnlyDirectories.some(
          (name) =>
            typeof name !== "string" ||
            name.trim().length === 0 ||
            name === "." ||
            name === ".." ||
            name.includes("/") ||
            name.includes("\\") ||
            name.includes("\u0000"),
        ))
    ) {
      throw new Error(
        "guestOnlyDirectories must be an array of nonblank directory names, excluding ., .., /, \\ and NUL",
      );
    }
    if (toggleHotkey !== undefined && !isToggleHotkey(toggleHotkey)) {
      throw new Error(
        "toggleHotkey must be a valid pi key identifier, e.g. ctrl+alt+s",
      );
    }

    let resolvedSandboxAgentsFile: string | undefined;
    if (sandboxAgentsFile !== undefined) {
      if (
        typeof sandboxAgentsFile !== "string" ||
        sandboxAgentsFile.length === 0 ||
        path.isAbsolute(sandboxAgentsFile)
      ) {
        throw new Error("sandboxAgentsFile must be a relative file path");
      }
      resolvedSandboxAgentsFile = path.resolve(agentDir, sandboxAgentsFile);
      if (!(await stat(resolvedSandboxAgentsFile)).isFile()) {
        throw new Error(
          `sandboxAgentsFile is not a file: ${sandboxAgentsFile}`,
        );
      }
    }

    let resolvedSecrets: Record<string, UserSecret> | undefined;
    if (secrets !== undefined) {
      if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
        throw new Error("secrets must be an object");
      }
      const secretEntries: [string, UserSecret][] = [];
      for (const [name, definition] of Object.entries(secrets)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new Error(
            `invalid guest secret environment variable name: ${JSON.stringify(name)}`,
          );
        }
        if (name === "HOME") throw new Error("secrets.HOME is reserved");
        if (
          !definition ||
          typeof definition !== "object" ||
          Array.isArray(definition)
        ) {
          throw new Error(`secrets.${name} must be an object`);
        }
        const { hostEnv, hosts } = definition as {
          hostEnv?: unknown;
          hosts?: unknown;
        };
        if (typeof hostEnv !== "string" || hostEnv.length === 0) {
          throw new Error(`secrets.${name}.hostEnv must be a non-empty string`);
        }
        if (
          hosts !== undefined &&
          (!Array.isArray(hosts) ||
            hosts.some((host) => typeof host !== "string"))
        ) {
          throw new Error(`secrets.${name}.hosts must be an array of strings`);
        }
        secretEntries.push([
          name,
          { hostEnv, ...(hosts === undefined ? {} : { hosts }) },
        ]);
      }
      resolvedSecrets = Object.fromEntries(secretEntries);
    }

    const resolvedMounts: string[] = [];
    for (const mount of mounts) {
      if (
        typeof mount !== "string" ||
        mount.length === 0 ||
        path.isAbsolute(mount)
      ) {
        throw new Error("mounts entries must be relative directory paths");
      }
      const resolved = path.resolve(agentDir, mount);
      const info = await stat(resolved);
      if (!info.isDirectory()) {
        throw new Error(`mount path is not a directory: ${mount}`);
      }
      resolvedMounts.push(resolved);
    }
    return {
      _version: 0,
      mounts: resolvedMounts,
      ...(guestOnlyDirectories === undefined ? {} : { guestOnlyDirectories }),
      ...(resolvedSandboxAgentsFile === undefined
        ? {}
        : { sandboxAgentsFile: resolvedSandboxAgentsFile }),
      ...(toggleHotkey === undefined ? {} : { toggleHotkey }),
      ...(resolvedSecrets === undefined ? {} : { secrets: resolvedSecrets }),
    };
  } catch (error) {
    throw new Error(
      `Invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
