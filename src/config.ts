import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_FILE = "gondolin-rises.json";

export type GondolinRisesConfig = {
  version: number;
};

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function loadConfig(
  agentDir: string,
): Promise<GondolinRisesConfig> {
  const configPath = path.join(agentDir, CONFIG_FILE);
  const readConfig = async () =>
    JSON.parse(await readFile(configPath, "utf8")) as GondolinRisesConfig;

  try {
    return await readConfig();
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }

  await mkdir(agentDir, { recursive: true });
  const config = { version: 0 };
  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      flag: "wx",
    });
    return config;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    return readConfig();
  }
}
