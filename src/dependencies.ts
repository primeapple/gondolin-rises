import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

export type HostDependencyOptions = {
  buildImage?: boolean;
  arch: "aarch64" | "x86_64";
  vmm?: string;
};

type HostDependency = {
  commands: string[];
  name: string;
  install: string;
};

function requiredDependencies(
  options: HostDependencyOptions,
  platform: NodeJS.Platform,
): HostDependency[] {
  const dependencies: HostDependency[] = [];
  if (options.buildImage) {
    dependencies.push({
      commands: ["mke2fs", "mkfs.ext4"],
      name: "mke2fs",
      install:
        platform === "darwin"
          ? "brew install e2fsprogs (ensure its sbin directory is on PATH)"
          : "install e2fsprogs (for example: sudo apt install e2fsprogs)",
    });
  }
  if (options.vmm?.trim().toLowerCase() !== "krun") {
    const qemuSystem =
      options.arch === "aarch64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
    dependencies.push({
      commands: [qemuSystem],
      name: qemuSystem,
      install:
        platform === "darwin"
          ? "brew install qemu"
          : `install QEMU system emulator (for example: sudo apt install ${options.arch === "aarch64" ? "qemu-system-arm" : "qemu-system-x86"})`,
    });
  }
  dependencies.push({
    commands: ["qemu-img"],
    name: "qemu-img",
    install:
      platform === "darwin"
        ? "brew install qemu"
        : "install QEMU utilities (for example: sudo apt install qemu-utils)",
  });
  return dependencies;
}

function searchDirectories(
  pathValue: string,
  platform: NodeJS.Platform,
): string[] {
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  if (platform === "darwin") {
    directories.push(
      "/opt/homebrew/opt/e2fsprogs/sbin",
      "/opt/homebrew/opt/e2fsprogs/bin",
      "/usr/local/opt/e2fsprogs/sbin",
      "/usr/local/opt/e2fsprogs/bin",
    );
  }
  return directories;
}

async function isExecutable(command: string, directories: string[]) {
  for (const directory of directories) {
    try {
      const filePath = path.join(directory, command);
      await access(filePath, constants.X_OK);
      if ((await stat(filePath)).isFile()) return true;
    } catch {
      // Keep checking PATH entries.
    }
  }
  return false;
}

export async function assertHostDependencies(
  options: HostDependencyOptions,
  environment: {
    path?: string;
    platform?: NodeJS.Platform;
  } = {},
): Promise<void> {
  const platform = environment.platform ?? process.platform;
  const directories = searchDirectories(
    environment.path ?? process.env.PATH ?? "",
    platform,
  );
  const missing: string[] = [];
  for (const dependency of requiredDependencies(options, platform)) {
    if (
      !(
        await Promise.all(
          dependency.commands.map((c) => isExecutable(c, directories)),
        )
      ).some(Boolean)
    ) {
      missing.push(`- ${dependency.name}: ${dependency.install}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required Gondolin host dependencies:\n${missing.join("\n")}`,
    );
  }
}
