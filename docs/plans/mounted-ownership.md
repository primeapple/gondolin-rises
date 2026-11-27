# Mounted ownership translation

Status: implemented; local tests pass. Real-VM acceptance pending. User approved implementation with real-VM checks deferred.

Requirements: [`docs/spec.md`, Mounted ownership](../spec.md#feature-mounted-ownership).

## Goal and bounds

Make host-owned checkouts usable by current root-run guest tools without Git trust exceptions. Keep guest separate from host.

Runtime-only change. Keep guest user, root privileges, shared writes, and image build process unchanged. No `safe.directory` writes, host `chown`, new config, dependency, guest package, startup directory scan, or persistent metadata store. Do not promise matching host and guest permission models.

Target current guest tool identity: UID/GID `0:0`. Read host process effective UID/GID once at startup. Translate matching UID and GID independently. Do not infer identity from checkout owner or erase foreign ownership. Host identity already `0:0` needs no translation.

## Change scope

- `docs/spec.md`: settle behavior before implementation. Keep spec change separate from implementation commit when commits are requested.
- `src/ownership-provider.ts` and `src/ownership-provider.test.ts` (new): small adapter over public Gondolin `VirtualProvider` interface. Translate returned stat snapshots; delegate remaining operations.
- `src/sandbox.ts`: read host IDs once; validate original `RealFSProvider.rootPath`; compose adapter around final shared or shadow provider for every CWD/configured mount.
- `src/sandbox.test.ts`: use real providers to prove composition, containment, isolated contents, and lifecycle behavior.
- `src/index.integration.test.ts`: verify Pi file tools and shell routing retain same mounted view. Fake VM coverage is not real guest verification.
- `src/test-fixtures.ts`: expose any additional upstream exports needed by tests; keep existing fake VM.
- `README.md`: describe translated ownership, unchanged host ownership, and remaining permission differences after validation passes.

Leave `src/build-config.ts`, `src/images.ts`, `src/dependencies.ts`, image cache keys, build config, `buildAssets()` delegation, and guest account setup unchanged. No tool interface changes expected in `src/operations.ts` or config wiring changes in `src/index.ts`/`src/user-config.ts`.

## Proposed test seams

Confirm seams before writing tests:

1. **Public provider interface:** ownership translation, untouched stat fields/methods, unchanged backing state, delegated operations. Does not prove guest kernel or Git behavior.
2. **Sandbox mounts and Pi tools:** provider composition, path containment, shared/isolated writes, off/on behavior. Fake shell does not prove real shell permissions.
3. **Real guest plus host observations:** plain Git, shell metadata, host ownership/mode, guest-only dependencies. Requires host able to start Gondolin VM.

Use `node:test`. Work one failing behavior test, minimum implementation, then next test. Do not write all tests before implementation. Refactor after passing slices.

## Implementation order

### 1. Spec and bounded proof

Review spec and test seams. Use temporary mounted Git checkout, not user's working checkout. Capture unmodified baseline: host/guest identity, metadata, plain `git status`, and metadata-query timing.

Build smallest adapter slice first: failing provider test for host-owned path stat, then mapping that passes. Extend through path and open-handle metadata before real-VM proof. Prefer public provider methods; do not rely on undocumented hook-result mutation. Preserve stat object shape and methods; never mutate backing provider's stat objects.

Run bounded proof before production mount wiring. Confirm `git status` works without command-line trust overrides, `safe.directory` entries, or spoofed `SUDO_UID`. Confirm original host ownership and mode remain unchanged. Mapping needs no additional filesystem lookups.

Stop and check in if proof needs upstream patches, new guest tools, build changes, weakened containment, or a general permission-emulation layer. Clone third-party dependency into temporary directory if debugging becomes necessary; never modify `node_modules`.

### 2. Complete adapter with red/green slices

Cover each behavior through public adapter interface:

- Matching UID and GID become `0`; unmatched IDs remain unchanged. Cover each match independently, both matches, neither match, and host IDs already `0`.
- `stat`, `lstat`, synchronous variants, and opened handle `stat`/`statSync` agree. Preserve backend-supported stat options and return shape; do not add new options.
- Preserve mode, timestamps, inode, device, link count, size, and file-type methods. Original stat snapshot remains unchanged.
- Forward reads, writes, creates, renames, deletes, access checks, symlink operations, chmod, and handle close through original provider. Preserve optional capabilities and errors; do not invent unsupported methods.
- Existing entries and newly created files/directories report same mapping.

Use stat fixtures for foreign ownership cases; no privileged host `chown` required. Use real temporary filesystem and memory providers for delegation and newly created entry checks.

### 3. Wire mounts with red/green slices

Validate original host roots before wrapping. Compose ownership adapter outside existing `ShadowProvider`, so shared entries and guest-created isolated entries get same ownership view. Preserve current shadow predicate and symlink-bypass guard.

Apply to CWD and every configured mount, including overlapping roots and symlink aliases. Do not apply to guest-local files outside host mounts or Gondolin internal mounts. Read effective host IDs once; reject unavailable/invalid IDs rather than silently using arbitrary values.

Keep VM startup, failed-start cleanup, retries, reuse, and shutdown unchanged. Do not issue guest identity queries or extra per-file filesystem calls.

### 4. Integration and real-VM acceptance

Add behavior tests before each integration change. Retain existing mount and shadow regression suite.

Use temporary projects and existing images only. Check default image and available custom image; never rebuild to make translation work. Verify:

- Plain `git status` and repository discovery work from checkout root and subdirectory. Include configured repository mount and linked worktree with required paths explicitly mounted. Retain mount containment; do not expose missing Git paths automatically.
- Guest `stat`/`lstat`/file-handle metadata agree on translated IDs. Modes and other metadata match baseline except intended test edits.
- Shell and Pi `read`/`write`/`edit` can create and edit shared files. Host sees normal host-created ownership; translation alone never changes host metadata.
- Guest-only dependencies remain separate and writable. Host dependency marker stays unchanged. Check executable/symlink lookup using local fixture, without network install.
- Escaping symlinks remain blocked. Foreign IDs remain unchanged in provider tests. Do not claim every foreign-owned repository must fail Git; guest root already matches host UID `0` entries.
- Sandbox off restores ordinary host view. Off/on reuse retains guest-only contents; fresh VM resets them.

Capture results with image/version and host identity. Mocked shell tests cannot substitute for these checks.

### 5. Performance and delivery gate

Compare plain versus translated providers using repeated path/handle metadata queries. Compare real guest metadata queries and `git status` on same checkout. Use paired runs and median timings; investigate repeatable slowdown beyond run-to-run variance. Keep timing assertions out of CI. No permanent benchmark framework needed.

Verify no additional filesystem lookups or startup scans. Translation handles metadata only, not file contents.

Run:

```sh
npm test
npm run format
npm run lint
npm run typecheck
```

Review final diff for unrelated changes. Update README and plan status only after acceptance passes. New VMs receive translated view by default; existing VMs need restart. No opt-in config or rollout toggle. Revert runtime adapter/wiring if acceptance fails; no image rebuild, Git config repair, or host ownership repair needed.

Do not stage, commit, or push unless asked.

## Verification constraints and effort

Current sandbox has Node.js 24 but no QEMU or `qemu-img`. Mounted development tools may target Darwin rather than Linux. Run real-VM checks on VM-capable host; run required npm checks on host or separate Linux-compatible dependency checkout. Never replace shared host `node_modules` to repair guest tools. Report blocked checks; do not mark validation complete.

Planning checks: `git diff --check` passes. `npm run format` and `npm run lint` fail: missing `@biomejs/cli-linux-arm64-musl/biome`. `npm run typecheck` fails: missing `@typescript/typescript-linux-arm64`. No alternative executables on PATH. Implementation tests and real-VM proof not run. No dependencies installed or replaced.

Estimate: 1–2 working days, including tests and real-VM checks, assuming public provider API suffices and validation host is available. Performance remains unmeasured. Any need to change Gondolin, build process, or permission model requires new scope decision.

## Local implementation checks — 2026-11-27

- Provider adapter wraps final shared/shadow provider on every host mount. Effective host IDs read once; no new filesystem lookups or scans. Host metadata unchanged. No config, dependency, image, guest identity, or Git config changes.
- Red/green coverage: ownership mapping, path/open-handle agreement, bigint values, missing-entry stat options, mount composition, invalid host IDs. Regression coverage retains containment, isolated writes, VM reuse, shutdown, and Pi tool routing. Fake shell only; no guest-kernel proof.
- `npm test`: 120 passed, 1 existing root-sensitive test skipped; 0 failed.
- `npm run format`, `npm run lint`, `npm run typecheck`, `npm run format:check`: passed after user-approved isolated install of Biome 2.6.8 and TypeScript 7.0.2 native packages. Compiler check exposed optional process-method mock typing; fixed with property mocks. Shared `node_modules`, package manifests, and lockfile untouched.
- Gondolin 0.14.0, Node 24.22.3, Linux ARM64, host effective IDs `0:0`. Provider fixtures cover non-root IDs `501:20` and foreign owners without host `chown`.
- Paired provider timing, 9 runs of 5,000 queries: median path `statSync` 5.83 µs plain / 6.23 µs translated; open-handle `statSync` 0.41 / 0.67 µs. Handle overhead repeatable; translation adds snapshot copy/delegation, not extra backing metadata query. No real guest timing or Git timing measured.
- Real-VM acceptance still needs VM-capable host: default/custom image, plain Git and linked worktrees, guest shell metadata, executable lookup, containment, and paired guest timings. No image built or VM started here.
