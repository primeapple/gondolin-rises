import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Parsed user config; mount paths resolved against the agent config directory. */
export interface UserConfig {
  readonly _version: 0;
  readonly mounts: readonly string[];
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
    const { _version, mounts } = config as {
      _version?: unknown;
      mounts?: unknown;
    };
    if (_version !== 0) throw new Error("_version must be 0");
    if (!Array.isArray(mounts)) throw new Error("mounts must be an array");

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
    return { _version: 0, mounts: resolvedMounts };
  } catch (error) {
    throw new Error(
      `Invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
