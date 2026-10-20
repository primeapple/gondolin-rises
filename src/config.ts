import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_FILE = "gondolin-rises.json";

export type GondolinRisesConfig = {
  version: 0;
  image: { packages: string[] };
};

function parseConfig(content: string): GondolinRisesConfig {
  const value: unknown = JSON.parse(content);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("gondolin-rises.json must contain an object");
  }

  const stored = value as Record<string, unknown>;
  if (stored.version !== 0) {
    throw new Error("gondolin-rises.json: version must be 0");
  }
  const imageValue = stored.image;
  if (
    imageValue !== undefined &&
    (typeof imageValue !== "object" ||
      imageValue === null ||
      Array.isArray(imageValue))
  ) {
    throw new Error("gondolin-rises.json: image must be an object");
  }

  const image = (imageValue ?? {}) as Record<string, unknown>;
  const packages = image.packages === undefined ? [] : image.packages;
  if (
    !Array.isArray(packages) ||
    !packages.every((pkg) => typeof pkg === "string")
  ) {
    throw new Error(
      "gondolin-rises.json: image.packages must be a list of strings",
    );
  }

  return {
    version: 0,
    image: { packages },
  };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function loadConfig(
  agentDir: string,
): Promise<GondolinRisesConfig> {
  const configPath = path.join(agentDir, CONFIG_FILE);
  const readConfig = async () =>
    parseConfig(await readFile(configPath, "utf8"));

  try {
    return await readConfig();
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }

  await mkdir(agentDir, { recursive: true });
  const config: GondolinRisesConfig = {
    version: 0,
    image: { packages: [] },
  };
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
