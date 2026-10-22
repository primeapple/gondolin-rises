import { readFile } from "node:fs/promises";
import path from "node:path";
import { type BuildConfig, parseBuildConfig } from "@earendil-works/gondolin";

export async function loadConfig(
  agentDir: string,
): Promise<BuildConfig | null> {
  const configPath = path.join(agentDir, "gondolin-build-config.json");
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw new Error(`Cannot read ${configPath}`, { cause: error });
  }
  try {
    return parseBuildConfig(content);
  } catch (error) {
    throw new Error(
      `Invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
