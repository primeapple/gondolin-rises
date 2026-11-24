# Gondolin sandbox options

## Scope

Research, not product requirements. Checked installed Gondolin `0.13.0`, matching `package-lock.json`, current `gondolin-build-config.json`, extension mount wiring, and shared agents' wishlist. No image builds, dependency installs, or sandbox changes performed.

## Decision

Two separate problems need separate fixes:

- **Linux tool compatibility:** Debian/Ubuntu OCI userspace removes Alpine/musl dependency friction.
- **Host/guest dependency compatibility:** Linux guest needs Linux dependencies. Replacing Alpine with Debian cannot make Darwin binaries run on Linux.

For one Linux VM model across x64 Linux and ARM Macs, keep Gondolin, use Debian OCI userspace, and separate guest dependencies from host dependencies. For execution matching host macOS, use host-native process sandbox or separate macOS VM backend. Gondolin builds Linux guests, not macOS guests. [1][2][3][4]

## Evidence from current setup

Current build config selects `arch: "aarch64"`, Alpine `3.23.0`, OS-provided Node.js, JDK 21/25, and post-build global pi installation. `src/sandbox.ts` mounts CWD and configured directories through plain `RealFSProvider`; no dependency hiding or guest-specific upper layer. [L1][L2]

Wishlist records missing Linux ARM64 TypeScript, Turbo, Rolldown/musl, and Biome packages. This checkout contains `@typescript/typescript-darwin-arm64` and `@biomejs/cli-darwin-arm64`, but no corresponding Linux packages. Installed TypeScript `7.0.2` declares separate native packages for Darwin and Linux. This is platform-specific dependency selection, not TypeScript source code failing on Linux. [L3][L4]

Other wishlist issues remain separate: required Node/JDK versions, root-sensitive permission tests, and internal artifact credentials. Debian alone cannot fix those. [L3]

## Option 1: Debian userspace inside Gondolin

Gondolin `0.13.0` already accepts `oci.image`, exports Docker/Podman image filesystem, and uses it as guest rootfs. Kernel and initramfs still come from Alpine components. Therefore `distro` must remain `"alpine"`; setting `"debian"` fails validation/build. `alpine.rootfsPackages` is ignored when OCI rootfs is selected. [1][2]

No Docker daemon needed inside guest. Build Dockerfile into OCI image first; Gondolin converts that filesystem into bootable Linux guest assets. This does not run ordinary Docker container at sandbox runtime. [1][2]

Illustrative config; image reference is placeholder:

```json
{
  "arch": "aarch64",
  "distro": "alpine",
  "oci": {
    "image": "ghcr.io/your-org/gondolin-dev:node",
    "platform": "linux/arm64"
  },
  "rootfs": {
    "label": "gondolin-root"
  }
}
```

Use `arch: "x86_64"` and OCI `platform: "linux/amd64"` on x64 Linux. Platform derives from `arch` when omitted. Native architecture on each host avoids cross-architecture runtime emulation. OCI rootfs needs `/bin/sh`; this extension also invokes `/bin/bash -lc`, so include Bash. [1][2][L5]

### Build repo proposal

Small image repo is reasonable:

- Shared Debian base plus workload-specific Dockerfiles or targets.
- Install OS packages and tools in Dockerfile; select Node/JDK versions required by each workload.
- Publish `linux/amd64` and `linux/arm64` OCI variants.
- Pin OCI digest for repeatable input; pin Gondolin version used for conversion.
- Either let clients convert OCI image with Docker/Podman and host build tools, or publish complete Gondolin asset archives per architecture. Second choice avoids client-side image builds.

These are design recommendations, not existing extension features. Upstream supports local asset paths, local image refs, and architecture-specific registry entries. Complete Gondolin assets include manifest, root disk, kernel, initramfs, and krun boot assets. [1][5]

For prebuilt assets, `GONDOLIN_GUEST_DIR` works when no extension build config selects custom-image workflow. Valid active custom image takes precedence over that environment variable. Current extension's update command rebuilds locally; it does not fetch image releases from custom build repo. [L6][L7]

### Important build limits

In `0.13.0`:

- `container.force: true` cannot combine with `oci`.
- OCI builds with `postBuild.commands` require native Linux host.
- Put existing global npm installation and other setup in Dockerfile rather than OCI `postBuild.commands` if clients build on macOS.
- Gondolin imports filesystem contents; do not assume Docker `ENTRYPOINT`, `CMD`, `USER`, or image environment metadata controls Gondolin execution. Configure Gondolin init/environment explicitly and test execution identity separately. [1][2]

## Dependency separation for cross-platform guests

Share source and lockfile, not Darwin `node_modules`. Give Linux guest its own dependency tree, including workspace-level dependency directories and other platform-specific build outputs. Guest installation must run with intended guest runtime/toolchain. [L3][L4]

**Do not run `npm ci` against current unmasked shared dependency tree. It can remove or replace host `node_modules`.** Current mount is writable and directly host-backed. [L2]

Upstream documents exact recipe: wrap `RealFSProvider` in `ShadowProvider`, hide `/node_modules`, and set `writeMode: "tmpfs"`. Reads then see guest-created dependencies; writes do not touch hidden host dependency directory. Default upper provider is `MemoryProvider`, so contents last only while provider lives. Optional `tmpfs` accepts another provider for separate backing storage. [3]

Current extension exposes directory mounts only; no shadow-path or dependency-store config. Image config alone cannot enable this recipe. Mount-policy change would need spec update and tests before implementation. [L2][L6]

Small first change: guest-only in-memory dependencies. Add persistent backing only when repeated install cost justifies it. If persistent cache is added, key by project, lockfile, guest OS/architecture/libc, and runtime/toolchain versions. Cache design is proposal; not tested here.

## Configurable directory isolation proposal

Proposed user config, not implemented or added to product spec:

```json
{
  "_version": 0,
  "mounts": [],
  "guestOnlyDirectories": ["node_modules", ".venv"]
}
```

Prefer directory names over regex for first version. Each entry matches whole path component at any depth within every mounted provider, including CWD. Empty default preserves current behavior. Reject empty names, `.`/`..`, and names containing separators. Regex adds escaping, stateful flag, performance, and overmatching concerns without solving demonstrated need.

Rules run on filesystem access, not recursive discovery. Wrap each `RealFSProvider` with `ShadowProvider`; matched host paths stay hidden, guest writes go to separate upper provider. This is isolation, not deletion or installation. Guest must install dependencies. Default memory upper layer disappears at sandbox shutdown. [3][L2]

Provider-only assertion probe with installed Gondolin `0.13.0` passed: deeply nested `node_modules` hidden; source file visible; guest-created directory visible only in upper layer; host marker unchanged; host dependency folder created after provider construction still hidden; symlink alias cannot read hidden host marker. Probe ran against temporary directory, not VM or real package installation.

Before production change, settle spec and add tests for all mounted roots, overlapping mounts and aliases, monorepos, source/lockfile writes, teardown, and real guest package installation. No regex engine, persistent cache, or automatic dependency discovery proposed for first version.

## Option 2: host-native macOS and Linux process sandbox

Anthropic Sandbox Runtime (`srt`) runs arbitrary commands under native OS controls: macOS `sandbox-exec`/Seatbelt, Linux `bubblewrap`, plus network proxies. Commands execute against host OS rather than Linux VM. macOS host-native dependencies therefore remain platform-matched, subject to permitted filesystem/toolchain access. [4]

This is closest match for “same underlying system.” No guest image or Dockerfile needed. Host provides installed toolchain; sandbox config sets filesystem/network access. Library and CLI exist, but package identifies itself as research preview. [4]

This is not drop-in Gondolin replacement. Current extension's filesystem tools execute through VM filesystem API. Native backend needs deliberate policy for `read`, `write`, `edit`, `bash`, and user shell commands, not only wrapper around Bash. [L2][L5][L6]

**Security boundary changes: native process sandbox shares host kernel; Gondolin uses separate Linux VM. Validate filesystem reads, writes, network access, secrets, and child processes before replacing VM backend.** Runtime README allows reads broadly by default, denies writes except allowed paths, and documents Unix-socket and other isolation caveats. Install sandbox runtime outside guest-writable/project-writable paths; rewriting its code can compromise later unsandboxed launcher runs. [4]

### Native backend feasibility

Use maintained runtime rather than hand-written Seatbelt profiles or raw bubblewrap command builder. Anthropic documents same primitives behind Claude Code's sandboxed Bash; SDK exports `SandboxManager.initialize`, `wrapWithSandbox`, dependency checks, violation tracking, and `reset`. Host starts proxies and sandbox wrappers; wrapped child performs restricted work. Inspected source identifies package as `0.0.83`. This is existing integration path, not new sandbox mechanism. [4][10][11]

Current extension already supplies custom `ReadOperations`, `WriteOperations`, `EditOperations`, and `BashOperations`. Those are swap points. Tool definitions, `/sandbox` toggle, hotkey queue, instruction replacement, and much UI wiring can stay. `createSandbox`/`ensureVm`, execution/file adapters, startup dependency checks, backend status/prompt, and secret wiring need changes. Image build/cache path stays Gondolin-specific. Adding native runtime also changes spec's “only runtime dependency: Gondolin” constraint. [L2][L5][L6][L8]

Small credible design:

- Explicit opt-in native backend; preserve Gondolin default. Never fall back to unsandboxed host execution after native startup failure.
- pi/controller remains outside sandbox. Start Bash through `srt` library wrapper.
- Run file operations in fixed helper process under same OS sandbox, passing content through stdin rather than shell arguments. This preserves OS enforcement for `read`/`write`/`edit`; direct host filesystem calls would bypass it.
- Adapt CWD/extra directories into native permissions rather than pretending macOS has guest mounts. Host toolchains need allowed reads; cache/temp directories need bounded writes.
- Keep directory-isolation option Gondolin-only. Native dependencies already match host; Seatbelt denying path is not Gondolin's writable upper-layer replacement.
- Preserve cancellation, timeouts, streaming output, shutdown, and busy-toggle semantics. Verify child-process-tree cleanup, not only wrapper exit.

This is backend change, not full Gondolin reimplementation. However, thin Bash-only wrapper is incomplete under current product requirements. [L5][L6][L8]

### New problems native backend introduces

- **Host state is real:** writable dependencies, source, or configuration persist on host. No disposable guest rootfs. Runtime/helper code must live outside allowed write paths or receive explicit write protection. Whole-home write permission is unsafe. [4]
- **Read policy differs:** `srt` allows reads broadly by default. Directory mounts currently limit which host trees guest receives; translating mount list only into `allowWrite` does not preserve that restriction. Explicit read policy and required toolchain reads needed. [4][L2]
- **Secrets need explicit port:** current Gondolin placeholders/hooks are not `srt` API. New runtime offers credential environment masking and host-scoped injection, but masking requires experimental TLS termination. Files can be masked on Linux; macOS denies masked files instead. Never forward all pi environment values into workload. [4][10][L5][L6]
- **macOS services:** `open`/`osascript` fail under default policy. Enabling `allowAppleEvents` lets applications launch outside sandbox and removes code-execution isolation; do not enable to silence routine errors. Unix sockets can expose powerful host services too. [4][10]
- **Linux prerequisites:** bubblewrap, socat, ripgrep, working user namespaces, and seccomp helpers. Some distributions restrict namespaces. Nested Chromium/Electron or rootless container tools can conflict with namespace restrictions; do not disable protections merely to make tests pass. [4]
- **Globs are not portable security contract:** macOS applies patterns in Seatbelt; Linux read globs expand existing paths at wrap time and write rules generally use literal paths. Broad home patterns can require discovery and produce skipped-pattern warnings. Prefer concrete native permission roots; keep Gondolin dependency-name masks separate. [4]
- **Session lifecycle:** SDK manager is process-global, not one instance per VM. Multiple consumers/configs within same pi process need coordination. Starting/stopping proxy state and cleaning up subprocesses needs tests. [10]
- **Isolation changes:** native shares host kernel. It cannot preserve VM boundary or uniform guest OS/toolchain merely through configuration. [1][4]

`srt pi` can serve as outer application sandbox, but does not preserve extension's split between trusted pi/controller and restricted workloads, or current on/off behavior. It must allow pi credentials and model API access while Bash remains in same outer process tree. Do not treat that shortcut as equivalent backend. [4][L6][L8]

### Evaluation proposal

Before production integration, run small macOS proof with `srt`: existing host-native npm dependencies execute; workspace edits succeed; forbidden home reads/writes fail through both Bash and file helper; unapproved network access fails; children stay restricted; timeout/cancel removes descendants. Then repeat on x64 Linux. No installation, OS-policy changes, native execution, or macOS testing performed in this research session.

## Option 3: full macOS VM

Apple Virtualization framework supports macOS guests on Apple Silicon. Tart builds, runs, and manages macOS/Linux VMs on Apple Silicon, supports VM distribution through OCI registries, and uses Packer for provisioning. Those VM artifacts are not ordinary Linux Docker images. [6][7]

This provides macOS guest plus VM boundary, but needs separate provisioning and execution backend. Not Gondolin configuration change. macOS VM also needs its own dependencies/toolchain compatible with guest macOS version. [1][6][7]

Apple's standard macOS license permits specified virtualization uses on Apple-branded computers already running Apple software, subject to license terms. This is not supported general-purpose macOS guest solution for ordinary x64 Linux PCs. Check applicable license before deploying or redistributing macOS VM images. [8]

Docker-based Linux environments do not become macOS sandboxes on a Mac. Apple's own `container` tool also explicitly runs Linux containers in lightweight Linux VMs. [9]

## Recommendation

Start with **Gondolin + Debian OCI userspace + guest-only dependencies** if consistent Linux execution and existing VM policy matter most. Image building already supports this; missing structural piece is mount policy.

Choose **host-native sandbox backend** if reusing macOS installs and matching host behavior matter more than keeping VM boundary. Evaluate `srt` before writing custom Seatbelt profiles.

Use **macOS VM backend** only for tasks requiring macOS APIs/tools with VM isolation. Do not build second VM stack solely to avoid separate Linux npm install.

## Verification

Repository checks after adding this note:

- Provider assertion probe: nested name masks, source visibility, guest-only writes, later-created host folders, and symlink read protection passed.
- `npm test`: 100 passed, 1 skipped, 0 failed.
- `npm run format` and `npm run lint`: blocked by missing `@biomejs/cli-linux-arm64-musl/biome`.
- `npm run typecheck`: blocked by missing `@typescript/typescript-linux-arm64`.

No dependency installation attempted. User-provided build config left unchanged. Image builds and alternative sandbox backends remain untested.

## Sources

1. [Gondolin custom images, v0.13.0](https://github.com/earendil-works/gondolin/blob/v0.13.0/docs/custom-images.md)
2. [Gondolin build guards](https://github.com/earendil-works/gondolin/blob/v0.13.0/host/src/build/index.ts), [OCI export and platform mapping](https://github.com/earendil-works/gondolin/blob/v0.13.0/host/src/alpine/oci.ts)
3. [Gondolin VFS: hiding node_modules but allowing installs](https://github.com/earendil-works/gondolin/blob/v0.13.0/docs/vfs.md#hiding-node-modules-but-allowing-installs), [ShadowProvider options](https://github.com/earendil-works/gondolin/blob/v0.13.0/host/src/vfs/shadow.ts)
4. [Anthropic Sandbox Runtime README, inspected commit](https://github.com/anthropics/sandbox-runtime/blob/0bbebed0aa9a8e628dc4df8bc30293550a1988eb/README.md)
5. [Gondolin SDK storage/image selection](https://github.com/earendil-works/gondolin/blob/v0.13.0/docs/sdk-storage.md), [CLI image management](https://github.com/earendil-works/gondolin/blob/v0.13.0/docs/cli.md)
6. [Apple Virtualization framework](https://developer.apple.com/documentation/virtualization), [Running macOS VM on Apple Silicon](https://developer.apple.com/documentation/virtualization/running-macos-in-a-virtual-machine-on-apple-silicon)
7. [Tart README, inspected commit](https://github.com/openai/tart/blob/c20da4f9bea82ed4794144c6c753c4d66066663b/README.md)
8. [Apple macOS license, sections 2B(iii) and 2D](https://www.apple.com/legal/sla/docs/macOS27.pdf)
9. [Apple container README, inspected commit](https://github.com/apple/container/blob/16e8d488ee1d9ede35ab9cf21b9973ffdc9361b3/README.md)
10. [srt manager API/lifecycle](https://github.com/anthropics/sandbox-runtime/blob/0bbebed0aa9a8e628dc4df8bc30293550a1988eb/src/sandbox/sandbox-manager.ts), [config schema](https://github.com/anthropics/sandbox-runtime/blob/0bbebed0aa9a8e628dc4df8bc30293550a1988eb/src/sandbox/sandbox-config.ts), [macOS wrapper](https://github.com/anthropics/sandbox-runtime/blob/0bbebed0aa9a8e628dc4df8bc30293550a1988eb/src/sandbox/macos-sandbox-utils.ts), [CLI process handling](https://github.com/anthropics/sandbox-runtime/blob/0bbebed0aa9a8e628dc4df8bc30293550a1988eb/src/cli.ts), [package version](https://github.com/anthropics/sandbox-runtime/blob/0bbebed0aa9a8e628dc4df8bc30293550a1988eb/package.json)
11. [Anthropic's first-party sandbox architecture](https://www.anthropic.com/engineering/claude-code-sandboxing)

Local evidence:

- **L1:** inspected `gondolin-build-config.json` in repository root; user-provided, untracked at research time.
- **L2:** [`src/sandbox.ts`](../../src/sandbox.ts), `RealFSProvider` construction and `VM.create` wiring.
- **L3:** `~/.local/state/agents-wishlist/wishlist.md`, especially entries `2026-10-28T12:35:18Z`, `2026-10-29T13:41:14Z`, `2026-11-12T08:50:24Z`, and toolchain/permission entries.
- **L4:** inspected `node_modules/typescript/package.json` and installed directories under `node_modules/@typescript` and `node_modules/@biomejs`; package versions fixed by [`package-lock.json`](../../package-lock.json).
- **L5:** [`src/operations.ts`](../../src/operations.ts).
- **L6:** [`docs/spec.md`](../spec.md), build config and sandbox requirements.
- **L7:** [`src/images.ts`](../../src/images.ts), startup image selection and `rebuildImage`.
- **L8:** [`src/index.ts`](../../src/index.ts), tool registration, lifecycle, status, toggle, and prompt wiring.
