import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import type { ExecOptions } from "@earendil-works/gondolin";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

type Call =
  | { operation: "access" | "read" | "mkdir" | "write"; path: string }
  | { operation: "bash"; args: string[]; options: ExecOptions };
type Handler = (event: object, ctx: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function text(result: Awaited<ReturnType<ToolDefinition["execute"]>>) {
  const block = result.content[0];
  assert.ok(block?.type === "text");
  return block.text;
}

// Real pi tool implementations; only VM boundary and config location are replaced.
const pi = await import("@earendil-works/pi-coding-agent");
const gondolin = await import("@earendil-works/gondolin");
let agentDir: string;
let activeVm: object;
mock.module("@earendil-works/pi-coding-agent", {
  namedExports: { ...pi, getAgentDir: () => agentDir },
});
mock.module("@earendil-works/gondolin", {
  namedExports: { ...gondolin, VM: { create: async () => activeVm } },
});
const { default: extension } = await import("./index.ts");

test("extension executes real pi tools in VM, then on host after toggle", async (t) => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "gondolin-integration-"),
  );
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  t.after(async () => {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(workspace, { recursive: true, force: true });
  });
  const fakeBin = path.join(workspace, "bin");
  await mkdir(fakeBin);
  for (const command of ["qemu-system-aarch64", "qemu-system-x86_64", "qemu-img"]) {
    const executable = path.join(fakeBin, command);
    await writeFile(executable, "#!/bin/sh\nexit 1\n");
    await chmod(executable, 0o755);
  }
  process.env.PATH = fakeBin;
  process.chdir(workspace);
  const guestCwd = process.cwd();
  agentDir = path.join(workspace, "agent");

  const files = new Map([
    [path.join(guestCwd, "example.txt"), Buffer.from("guest original\n")],
    [path.join(guestCwd, "..notes"), Buffer.from("dotdot name\n")],
  ]);
  const calls: Call[] = [];
  const close = mock.fn(async () => {});
  activeVm = {
    fs: {
      access: async (p: string) => {
        calls.push({ operation: "access", path: p });
        if (!files.has(p)) throw new Error("ENOENT");
      },
      readFile: async (p: string) => {
        calls.push({ operation: "read", path: p });
        if (!files.has(p)) throw new Error("ENOENT");
        return files.get(p);
      },
      mkdir: async (p: string) => {
        calls.push({ operation: "mkdir", path: p });
      },
      writeFile: async (p: string, content: string) => {
        calls.push({ operation: "write", path: p });
        files.set(p, Buffer.from(content));
      },
    },
    exec: (args: string[], options: ExecOptions = {}) => {
      if (args[0] === "/bin/sh")
        return Promise.resolve({ ok: true, stdout: "text/plain\n" });
      calls.push({ operation: "bash", args, options });
      return Object.assign(Promise.resolve({ exitCode: 0 }), {
        output: async function* () {
          yield { data: Buffer.from("guest shell\n") };
        },
      });
    },
    close,
  };
  await writeFile(path.join(workspace, "example.txt"), "host original\n");
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const ctx = {
    cwd: guestCwd,
    waitForIdle: async () => {},
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: () => {},
      notify: () => {},
    },
  } as unknown as ExtensionCommandContext;
  await extension({
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, command: Command) => {
      commands.set(name, command);
    },
    registerFlag: () => {},
    getFlag: () => false,
    on: (name: string, handler: Handler) => {
      events.set(name, handler);
      return () => events.delete(name);
    },
  } as unknown as ExtensionAPI);
  const emit = async (name: string) => {
    const handler = events.get(name);
    assert.ok(handler);
    await handler({ type: name }, ctx);
  };
  t.after(() => emit("session_shutdown"));
  await emit("session_start");
  const execute = (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    assert.ok(tool);
    return tool.execute(
      "id",
      args,
      undefined,
      undefined,
      ctx as unknown as ExtensionToolContext,
    );
  };
  const toggle = async () => {
    const command = commands.get("sandbox");
    assert.ok(command);
    await command.handler("", ctx);
  };

  const read = await execute("read", { path: "example.txt" });
  assert.equal(text(read), "guest original\n");
  assert.equal(
    text(await execute("read", { path: path.join(guestCwd, "example.txt") })),
    "guest original\n",
  );
  assert.equal(
    text(await execute("read", { path: "..notes" })),
    "dotdot name\n",
  );
  await execute("write", {
    path: "nested/new.txt",
    content: "guest written\n",
  });
  assert.equal(
    files.get(path.join(guestCwd, "nested/new.txt"))?.toString(),
    "guest written\n",
  );
  await execute("edit", {
    path: path.join(guestCwd, "example.txt"),
    edits: [{ oldText: "guest original", newText: "guest edited" }],
  });
  assert.equal(
    files.get(path.join(guestCwd, "example.txt"))?.toString(),
    "guest edited\n",
  );
  const shell = await execute("bash", { command: "printf 'guest shell\\n'" });
  assert.equal(text(shell), "guest shell\n");
  assert.ok(
    calls.some(
      (call) =>
        call.operation === "read" &&
        call.path === path.join(guestCwd, "example.txt"),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.operation === "mkdir" &&
        call.path === path.join(guestCwd, "nested"),
    ),
  );
  const bash = calls.find((call) => call.operation === "bash");
  assert.ok(bash);
  assert.equal(bash.options.cwd, guestCwd);
  assert.equal(bash.options.env, undefined);
  assert.equal(
    await readFile(path.join(workspace, "example.txt"), "utf8"),
    "host original\n",
  );

  await assert.rejects(
    execute("edit", {
      path: "example.txt",
      edits: [{ oldText: "not present", newText: "bad" }],
    }),
  );
  await assert.rejects(execute("read", { path: "missing.txt" }), /ENOENT/);
  await assert.rejects(
    execute("read", { path: path.join(guestCwd, "..", "sibling", "file") }),
    /path escapes workspace/,
  );
  await toggle();
  const host = await execute("read", { path: "example.txt" });
  assert.equal(text(host), "host original\n");
  await execute("write", { path: "host.txt", content: "host written\n" });
  assert.equal(
    await readFile(path.join(workspace, "host.txt"), "utf8"),
    "host written\n",
  );
  assert.equal(files.has(path.join(guestCwd, "host.txt")), false);
  await toggle();
  assert.equal(
    text(await execute("read", { path: "example.txt" })),
    "guest edited\n",
  );
  await emit("session_shutdown");
  assert.equal(close.mock.callCount(), 1);
});
