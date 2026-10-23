import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import os from "node:os";
import { test } from "node:test";
import path from "node:path";
import type { ExecOptions, VM } from "@earendil-works/gondolin";
import {
  createGondolinBashOps,
  createGondolinEditOps,
  createGondolinReadOps,
  createGondolinWriteOps,
  guestWorkspacePath,
} from "./operations.ts";

type FakeVm = { exec: (args: string[], options: ExecOptions) => unknown };
function bashOps(vm: FakeVm) {
  // Fake replaces only VM execution, not Gondolin lifecycle or filesystem.
  return createGondolinBashOps(vm as unknown as VM, process.cwd());
}

test("file tools allow paths through configured home directory", async () => {
  const cwd = process.cwd();
  const home = os.homedir();
  const target = path.join(home, "shared", "file.txt");
  const guestTarget = guestWorkspacePath(target);
  const guestParent = path.posix.dirname(guestTarget);
  const calls: string[] = [];
  const vm = {
    fs: {
      access: async (p: string) => {
        calls.push(`access:${p}`);
      },
      readFile: async (p: string) => {
        calls.push(`read:${p}`);
        return Buffer.from("content");
      },
      mkdir: async (p: string) => {
        calls.push(`mkdir:${p}`);
      },
      writeFile: async (p: string) => {
        calls.push(`write:${p}`);
      },
    },
  } as unknown as VM;
  await createGondolinReadOps(vm, cwd, [home]).readFile(target);
  await createGondolinWriteOps(vm, cwd, [home]).writeFile(target, "new");
  const edit = createGondolinEditOps(vm, cwd, [home]);
  await edit.access(target);
  await edit.readFile(target);
  await edit.writeFile(target, "edited");
  assert.deepEqual(calls, [
    `read:${guestTarget}`,
    `mkdir:${guestParent}`,
    `write:${guestTarget}`,
    `access:${guestTarget}`,
    `read:${guestTarget}`,
    `mkdir:${guestParent}`,
    `write:${guestTarget}`,
  ]);
});

test("pre-aborted bash never starts VM execution", async () => {
  let executions = 0;
  const vm = {
    exec: () => {
      executions++;
      return Object.assign(Promise.resolve({ exitCode: 0 }), {
        output: async function* () {},
      });
    },
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    bashOps(vm).exec("true", process.cwd(), {
      signal: controller.signal,
      onData: () => {},
    }),
    /^Error: aborted$/,
  );
  assert.equal(executions, 0);
});

test("write and edit use guest path for additional mounted roots", async () => {
  const cwd = process.cwd();
  const agents = path.join(path.dirname(cwd), ".agents");
  const paths: string[] = [];
  const vm = {
    fs: {
      access: async (p: string) => paths.push(`access:${p}`),
      readFile: async (p: string) => {
        paths.push(`read:${p}`);
        return Buffer.from("skill content");
      },
      mkdir: async (p: string) => paths.push(`mkdir:${p}`),
      writeFile: async (p: string) => paths.push(`write:${p}`),
    },
  };
  const skillPath = path.join(agents, "SKILL.md");
  const guestSkillPath = path.posix.join(
    guestWorkspacePath(agents),
    "SKILL.md",
  );

  await createGondolinWriteOps(vm as unknown as VM, cwd, [agents]).writeFile(
    skillPath,
    "updated",
  );
  const edit = createGondolinEditOps(vm as unknown as VM, cwd, [agents]);
  await edit.access(skillPath);
  await edit.readFile(skillPath);
  await edit.writeFile(skillPath, "edited");

  assert.deepEqual(paths, [
    `mkdir:${guestWorkspacePath(agents)}`,
    `write:${guestSkillPath}`,
    `access:${guestSkillPath}`,
    `read:${guestSkillPath}`,
    `mkdir:${guestWorkspacePath(agents)}`,
    `write:${guestSkillPath}`,
  ]);
});

test("read uses guest path for additional mounted roots, but rejects others", async () => {
  const cwd = process.cwd();
  const agents = path.join(path.dirname(cwd), ".agents");
  const guestPaths: string[] = [];
  const vm = {
    fs: {
      access: async (p: string) => {
        guestPaths.push(p);
      },
      readFile: async (p: string) => {
        guestPaths.push(p);
        return Buffer.from("skill content");
      },
    },
  };
  const ops = createGondolinReadOps(vm as unknown as VM, cwd, [agents]);
  const skillPath = path.join(agents, "SKILL.md");

  await ops.access(skillPath);
  assert.equal((await ops.readFile(skillPath)).toString(), "skill content");
  assert.deepEqual(guestPaths, [
    path.posix.join(guestWorkspacePath(agents), "SKILL.md"),
    path.posix.join(guestWorkspacePath(agents), "SKILL.md"),
  ]);
  await assert.rejects(
    ops.readFile(path.join(path.dirname(agents), "secret.txt")),
    /path escapes workspace/,
  );
});

function waitingVm(started?: PromiseWithResolvers<AbortSignal>): FakeVm {
  return {
    exec: (_args, { signal }) => {
      assert.ok(signal);
      const result = new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("VM cancelled")),
          { once: true },
        );
      });
      started?.resolve(signal);
      return Object.assign(result, {
        output: async function* () {
          yield { data: Buffer.from("running") };
          await result;
        },
      });
    },
  };
}

test("bash forwards cancellation and removes caller abort listener", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const controller = new AbortController();
  const execution = bashOps(waitingVm(started)).exec(
    "sleep 10",
    process.cwd(),
    {
      signal: controller.signal,
      onData: () => {},
    },
  );
  const rejection = assert.rejects(execution, /^Error: aborted$/);
  const guestSignal = await started.promise;
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  await rejection;
  assert.equal(guestSignal.aborted, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("bash timeout cancels VM execution with timeout error", async () => {
  const controller = new AbortController();
  await assert.rejects(
    bashOps(waitingVm()).exec("sleep 10", process.cwd(), {
      signal: controller.signal,
      timeout: 0.001,
      onData: () => {},
    }),
    /^Error: timeout:0.001$/,
  );
  assert.equal(controller.signal.aborted, false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("bash streams both output channels and preserves exit code", async () => {
  const chunks: string[] = [];
  const controller = new AbortController();
  const vm = {
    exec: (_args: string[], options: ExecOptions) => {
      assert.equal(options.cwd, process.cwd());
      assert.equal(options.env, undefined);
      return Object.assign(Promise.resolve({ exitCode: 7 }), {
        output: async function* () {
          yield { stream: "stdout", data: Buffer.from("out") };
          yield { stream: "stderr", data: Buffer.from("err") };
        },
      });
    },
  };
  const result = await bashOps(vm).exec("exit 7", process.cwd(), {
    signal: controller.signal,
    onData: (chunk) => chunks.push(chunk.toString()),
  });
  assert.deepEqual(chunks, ["out", "err"]);
  assert.deepEqual(result, { exitCode: 7 });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("bash preserves VM errors without treating them as cancellation", async () => {
  const failure = new Error("VM unavailable");
  const vm = {
    exec: () => {
      throw failure;
    },
  };
  await assert.rejects(
    bashOps(vm).exec("true", process.cwd(), {
      onData: () => {},
    }),
    (error) => error === failure,
  );
});
