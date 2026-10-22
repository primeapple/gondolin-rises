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
  if (path.parse(localCwd).root === localCwd) {
    throw new Error("cannot mount host filesystem root as Gondolin workspace");
  }
  return localCwd.split(path.sep).join(path.posix.sep);
}

function shQuote(value: string): string {
  // POSIX shell quoting: wraps in single quotes and escapes internal quotes
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function toGuestPath(localCwd: string, localPath: string): string {
  const resolved = path.resolve(localCwd, localPath);
  const rel = path.relative(localCwd, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  // Guest mount path matches host CWD; convert platform separators to POSIX.
  return path.posix.join(
    guestWorkspacePath(localCwd),
    rel.split(path.sep).join(path.posix.sep),
  );
}

export function createGondolinReadOps(
  vm: VM,
  localCwd: string,
): ReadOperations {
  return {
    readFile: async (p) => {
      return vm.fs.readFile(toGuestPath(localCwd, p));
    },
    access: async (p) => {
      await vm.fs.access(toGuestPath(localCwd, p), { mode: fsConstants.R_OK });
    },
    detectImageMimeType: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
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
): WriteOperations {
  return {
    // Use the VM filesystem API rather than a shell round-trip: it streams the
    // content, so there is no argv size limit and no quoting to get wrong.
    writeFile: async (p, content) => {
      const guestPath = toGuestPath(localCwd, p);
      await vm.fs.mkdir(path.posix.dirname(guestPath), { recursive: true });
      await vm.fs.writeFile(guestPath, content);
    },
    mkdir: async (dir) => {
      await vm.fs.mkdir(toGuestPath(localCwd, dir), { recursive: true });
    },
  };
}

export function createGondolinEditOps(
  vm: VM,
  localCwd: string,
): EditOperations {
  const r = createGondolinReadOps(vm, localCwd);
  const w = createGondolinWriteOps(vm, localCwd);
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
