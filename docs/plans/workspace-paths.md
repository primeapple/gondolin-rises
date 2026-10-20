# Deferred: workspace path contract

Status: deferred. Do not change path behavior during architecture cleanup.

## Problem

`src/index.ts` advertises `/workspace` in model prompt, but file tools resolve paths against host working directory. Adapter accepts only paths beneath host directory. Absolute guest path such as `/workspace/README.md` fails with `path escapes workspace`; relative paths work.

Current escape check uses `rel.startsWith("..")`, also rejecting valid workspace name such as `..notes`.

After extraction, path policy belongs in `src/operations.ts`; prompt wiring stays in `src/index.ts`.

## Decisions needed

- Accepted relative, host absolute, and guest absolute paths.
- Workspace limits for file tools versus shell commands.
- Host-path compatibility and behavior across sandbox toggles.
- Guest paths outside `/workspace`: reject or support explicitly.

## Proposed fix

Settle `docs/spec.md` first, in change separate from implementation.

Use one workspace path contract. Resolve relative paths within workspace. Accept guest absolute paths within `/workspace`; preserve host-path compatibility where needed. Keep outside-workspace rejection. Check parent-directory segments, not every name beginning with `..`.

Do not broaden host filesystem access or weaken Gondolin mount isolation.

## Verification

Use `node:test`, without LLM calls. Cover relative paths, `/workspace` absolute paths, agreed host absolute forms, root path, `..notes`, parent traversal, sibling directories, and platform separators. Check same policy across read, write, edit, and bash working directory. Include extension-level execution checks, not only operation-object routing.

Implement only after explicit approval of path contract.
