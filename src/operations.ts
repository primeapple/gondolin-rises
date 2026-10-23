import { constants as fsConstants } from "node:fs";
import path from "node:path";
import type { VM } from "@earendil-works/gondolin";
import type {
  BashOperations,
  EditOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";

export function guestWorkspacePath(localCwd: string): string {
  return localCwd.split(path.sep).join(path.posix.sep);
}

function shQuote(value: string): string {
  // POSIX shell quoting: wraps in single quotes and escapes internal quotes
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function toGuestPath(
  localCwd: string,
  localPath: string,
  additionalRoots: readonly string[] = [],
): string {
  const resolved = path.resolve(localCwd, localPath);
  const root = [localCwd, ...additionalRoots].find((candidate) =>
    isWithin(path.resolve(candidate), resolved),
  );
  if (!root) throw new Error(`path escapes workspace: ${localPath}`);

  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolved);
  // Guest mount path matches host path; convert platform separators to POSIX.
  return path.posix.join(
    guestWorkspacePath(resolvedRoot),
    rel.split(path.sep).join(path.posix.sep),
  );
}

export function createGondolinReadOps(
  vm: VM,
  localCwd: string,
  additionalRoots: readonly string[] = [],
): ReadOperations {
  return {
    readFile: async (p) => {
      return vm.fs.readFile(toGuestPath(localCwd, p, additionalRoots));
    },
    access: async (p) => {
      await vm.fs.access(toGuestPath(localCwd, p, additionalRoots), {
        mode: fsConstants.R_OK,
      });
    },
    detectImageMimeType: async (p) => {
      const guestPath = toGuestPath(localCwd, p, additionalRoots);
      try {
        // Run through the shell because `file` might live in `/usr/bin` depending on the image
        const r = await vm.exec([
          "/bin/sh",
          "-lc",
          `file --mime-type -b ${shQuote(guestPath)}`,
        ]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
          m,
        )
          ? m
          : null;
      } catch {
        return null;
      }
    },
  };
}

export function createGondolinWriteOps(
  vm: VM,
  localCwd: string,
  additionalRoots: readonly string[] = [],
): WriteOperations {
  return {
    // Use the VM filesystem API rather than a shell round-trip: it streams the
    // content, so there is no argv size limit and no quoting to get wrong.
    writeFile: async (p, content) => {
      const guestPath = toGuestPath(localCwd, p, additionalRoots);
      await vm.fs.mkdir(path.posix.dirname(guestPath), { recursive: true });
      await vm.fs.writeFile(guestPath, content);
    },
    mkdir: async (dir) => {
      await vm.fs.mkdir(toGuestPath(localCwd, dir, additionalRoots), {
        recursive: true,
      });
    },
  };
}

export function createGondolinEditOps(
  vm: VM,
  localCwd: string,
  additionalRoots: readonly string[] = [],
): EditOperations {
  const r = createGondolinReadOps(vm, localCwd, additionalRoots);
  const w = createGondolinWriteOps(vm, localCwd, additionalRoots);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

export function createGondolinBashOps(
  vm: VM,
  localCwd: string,
): BashOperations {
  return {
    // The host environment passed by pi is intentionally not forwarded: it
    // usually contains API keys and other credentials.  Configure secrets for
    // the guest with `httpHooks` (see docs/secrets.md) instead.
    exec: async (command, cwd, { onData, signal, timeout }) => {
      if (signal?.aborted) throw new Error("aborted");
      const guestCwd = toGuestPath(localCwd, cwd);

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              ac.abort();
            }, timeout * 1000)
          : undefined;

      try {
        // `/bin/bash -lc` for a familiar environment (pipelines, expansions, etc.)
        const proc = vm.exec(["/bin/bash", "-lc", command], {
          cwd: guestCwd,
          signal: ac.signal,
          stdout: "pipe",
          stderr: "pipe",
        });

        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }

        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
