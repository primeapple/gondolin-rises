import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Parsed user config; paths resolved against the agent config directory. */
export interface UserConfig {
  readonly _version: 0;
  readonly mounts: readonly string[];
  readonly sandboxAgentsFile?: string;
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
    const { _version, mounts, sandboxAgentsFile } = config as {
      _version?: unknown;
      mounts?: unknown;
      sandboxAgentsFile?: unknown;
    };
    if (_version !== 0) throw new Error("_version must be 0");
    if (!Array.isArray(mounts)) throw new Error("mounts must be an array");

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
      ...(resolvedSandboxAgentsFile === undefined
        ? {}
        : { sandboxAgentsFile: resolvedSandboxAgentsFile }),
    };
  } catch (error) {
    throw new Error(
      `Invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
