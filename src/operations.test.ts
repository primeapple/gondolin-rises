import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import path from "node:path";
import type { ExecOptions, VM } from "@earendil-works/gondolin";
import { createGondolinBashOps, guestWorkspacePath } from "./operations.ts";

type FakeVm = { exec: (args: string[], options: ExecOptions) => unknown };
function bashOps(vm: FakeVm) {
  // Fake replaces only VM execution, not Gondolin lifecycle or filesystem.
  return createGondolinBashOps(vm as unknown as VM, process.cwd());
}

test("refuses to mount host filesystem root", () => {
  assert.throws(
    () => guestWorkspacePath(path.parse(process.cwd()).root),
    /cannot mount host filesystem root/,
  );
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
