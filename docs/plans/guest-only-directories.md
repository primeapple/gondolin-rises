# Guest-only directories

Status: implementation complete. Host checks and real guest smoke check pending; see verification constraints.

Requirements: [`docs/spec.md`, Guest-only directories](../spec.md#feature-guest-only-directories). Usage example: [README](../../README.md#guest-only-directories).

## Goal

Keep host dependencies out of Linux guest filesystem view without deleting host files or walking mounted trees. Guest can install compatible dependencies at normal project paths.

First version uses `guestOnlyDirectories`, a list of literal directory names such as `node_modules`. No arbitrary path rules, regex, automatic installs, persistent cache, image changes, native backend, or new runtime dependency.

## Change scope

- `src/user-config.ts`: optional field, validation, parsed values. Keep `_version: 0` and existing config unchanged.
- `src/index.ts`: pass validated names into sandbox creation.
- `src/sandbox.ts`: compose mount providers after existing root validation; preserve startup, toggle, and shutdown behavior.
- `src/user-config.test.ts`, `src/sandbox.test.ts`, and `src/index.integration.test.ts`: validation, provider behavior, and tool routing coverage.
- `src/test-fixtures.ts`: expose real upstream shadow provider through Gondolin mock; retain fake VM.
- `README.md`: remove planned warning only when implementation is delivered.

No changes expected in image builder, package dependencies, or tool operation interfaces. Keep this spec/documentation change separate from later implementation commit; do not stage or commit unless asked.

## Implementation order

1. **Config red/green.** Add failing `node:test` cases for parsed names and invalid values. Cover missing field, empty list, `node_modules`, `.venv`, non-array values, non-string entries, blank names, `.`, `..`, separators, and NUL. Implement minimum validation. Invalid config must prevent VM creation, not silently disable isolation.
2. **Mount red/green.** Add failing tests against providers captured from fake VM options. Use real filesystem and upstream `ShadowProvider`, not constructor-only assertions. Implement name matching and provider composition once tests demonstrate missing behavior.
3. **Wire config.** Pass names from `src/index.ts` into `createSandbox`. Validate original `RealFSProvider.rootPath` before wrapping. With no rules, retain plain providers. With rules, use upstream `ShadowProvider` with `writeMode: "tmpfs"` and default in-memory upper provider. Keep default symlink-bypass protection. Match complete path components; account for canonical mount roots already inside isolated subtrees.
4. **Lifecycle and routing red/green.** Prove tools and shell commands receive same VFS view; disabled sandbox uses host view. Preserve guest contents across off/on reuse. Fresh VM must use fresh upper contents. Refactor only where tests require it.
5. **Guest smoke check.** Use temporary mounted project with host dependency marker and tiny local npm package fixture. Run guest installation and executable/symlink lookup. Verify guest sees its dependencies and host marker/tree remains unchanged. No installation into user's real host dependency tree.
6. **Delivery checks.** Run full suite and required formatting/lint/type checks. Remove README's planned warning after implementation and mark plan resolved. Leave spec requirements unchanged unless behavior decision needs separate spec change.

## Essential regressions

- Root and deeply nested `node_modules`; multiple names; exact, case-sensitive matches. `node_modules_backup` remains visible.
- Host contents omitted from reads/listings; guest can create files/directories in isolated view. Operations targeting isolated paths never mutate hidden host data. Shared ancestor renames remain allowed and may move hidden host descendants; no guard or recursive scan.
- Source and lockfiles remain shared. Guest installation does not replace host dependency contents.
- CWD plus every configured mount, including broad home mount. Overlapping mounts and mounts directly rooted within isolated directory cannot expose lower host tree.
- Host dependency directory created after startup is still hidden; no precomputed directory inventory.
- Symlink aliases cannot reveal or mutate hidden host contents. Existing escaping-symlink and mount-root restrictions still pass.
- All standard file tools, Bash, and user `!` routing; empty/default config; busy toggle, VM reuse, and shutdown.

## Verification constraints

Current VM cannot run mounted Darwin TypeScript/Biome binaries. Run required checks on configured macOS host or separate Linux-compatible dependency checkout. Do not run `npm ci` in current unmasked shared checkout to fix validation tools.

Config, provider, lifecycle, and real Pi tool tests cover isolation, shared ancestor renames, and guest executable symlink lookup. Shell boundary remains mocked. Real VM package installation remains unverified: current VM lacks QEMU and qemu-img. Formatting, lint, and type checks remain blocked by missing Linux-compatible binaries.

Reference: [upstream Gondolin v0.13.0 recipe](https://github.com/earendil-works/gondolin/blob/v0.13.0/docs/vfs.md#hiding-node-modules-but-allowing-installs).
