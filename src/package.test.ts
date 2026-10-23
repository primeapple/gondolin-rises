import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("package includes every runtime module", async () => {
  const { stdout } = await exec("npm", [
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
  ]);
  const [{ files }]: { files: { path: string }[] }[] = JSON.parse(stdout);
  const paths = files.map((file) => file.path);
  assert.deepEqual(paths.filter((p) => p.startsWith("src/")).sort(), [
    "src/build-config.ts",
    "src/dependencies.ts",
    "src/images.ts",
    "src/index.ts",
    "src/operations.ts",
    "src/sandbox.ts",
    "src/user-config.ts",
  ]);
  assert.equal(
    paths.some((p) => p.endsWith(".test.ts")),
    false,
  );
});
