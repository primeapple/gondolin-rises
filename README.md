# Gondolin Rises

[pi](https://github.com/earendil-works/pi) extension running `read`, `write`, `edit`, and `bash` inside a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM.

Based on upstream [pi-gondolin.ts example](https://github.com/earendil-works/gondolin/blob/main/host/examples/pi-gondolin.ts). Entry point: [`src/index.ts`](src/index.ts).

## Requirements

- Node.js 24 or newer.
- pi installed, with `pi` on `PATH`.
- QEMU system emulator matching guest architecture for default `qemu` backend.
- `qemu-img` for copy-on-write root disk.
- Native custom image builds need `cpio`, `lz4`, and `mke2fs` from `e2fsprogs`.
- OCI builds also need Docker or Podman and `debugfs` from `e2fsprogs`. Container builds need Docker or Podman instead of host image-build tools.

On macOS (`cpio` ships with macOS):

```sh
brew install qemu lz4 e2fsprogs
```

On Debian/Ubuntu (ARM64 example):

```sh
sudo apt install qemu-system-arm qemu-utils lz4 cpio e2fsprogs
```

On Arch (x86):

```sh
pacman -S qemu-img qemu-system-x86 lz4 cpio e2fsprogs
```

Pi checks host tools before VM startup and custom image builds, and lists missing dependencies with install hints. `GONDOLIN_VMM=krun` skips QEMU system emulator check.

## Install

```sh
pi install git:github.com/primeapple/gondolin-rises
```

Or use local installation:

```sh
pi --no-extensions -e /path/to/gondolin-rises
```

## Features

### Sandbox

Sandbox starts on. Run `/sandbox` inside pi to toggle off or on. Toggle waits for agent to become idle.

When sandbox is on, optional `gondolin-rises.json` in Pi's agent config directory (`~/.pi/agent` by default; honors `PI_CODING_AGENT_DIR`) lists extra host directories to mount. Paths resolve relative to that config file and mount at the same guest path. All sandbox tools can read and write through them. For example, mount `~/.agents`:

```json
{
  "_version": 0,
  "mounts": ["../../.agents"]
}
```

No config means no extra mounts. Invalid config blocks sandbox startup. CWD and configured mounts must resolve inside your home directory or host temp directory (`os.tmpdir()`), including either directory itself. Mounted directories are writable from guest commands. Gondolin blocks host symlink targets outside each mount root on access, even if target is elsewhere in home. No recursive symlink scan or symlink warnings. Guest VM files outside home remain accessible.

Configure HTTP secrets in the same file by mapping guest environment variable names to host environment variables and allowed substitution hosts:

```json
{
  "_version": 0,
  "mounts": [],
  "secrets": {
    "GH_TOKEN": {
      "hostEnv": "GITHUB_TOKEN",
      "hosts": ["api.github.com"]
    }
  }
}
```

Set `GITHUB_TOKEN` in pi's host environment. Guest sees placeholder in `GH_TOKEN`; Gondolin substitutes real value into supported outbound request headers for listed hosts. Missing or empty credentials block sandbox startup. Guest variable names must match `[A-Za-z_][A-Za-z0-9_]*`; `HOME` is reserved. Per-secret `hosts` only limits token substitution; it does not restrict general network access. Tokens still grant guest code their full permissions at allowed hosts.

When off, `read`, `write`, `edit`, `bash`, and user `!` commands run directly on host, without VM isolation. Status and notification show current state.

### Sandbox instructions

Optional `sandboxAgentsFile` in `gondolin-rises.json` selects replacement global instructions:

```json
{
  "_version": 0,
  "mounts": [],
  "sandboxAgentsFile": "./SANDBOX_AGENTS.md"
}
```

Path must be relative to Pi's agent config directory (`~/.pi/agent` by default; honors `PI_CODING_AGENT_DIR`). Extension reads file from host at startup; no mount or image rebuild needed. Missing, non-file, or unreadable configured target blocks sandbox startup. Unset field keeps normal global instructions. Empty file suppresses normal global instructions.

Configured sandbox instruction file replaces normal global instructions; contents are not appended or supplied alongside normal global instructions. Project instructions remain unchanged. Instruction selection happens at startup. Enabling or disabling sandbox during session changes tool execution only; instructions remain selected at startup.

### Custom images

Optional `gondolin-build-config.json` in Pi's agent config directory (default: `~/.pi/agent`) uses [upstream Gondolin build-config format](https://earendil-works.github.io/gondolin/custom-images/). Extension honors `PI_CODING_AGENT_DIR`. Generate starting config with Gondolin CLI, then edit packages or other build settings:

```sh
# Adjust destination if PI_CODING_AGENT_DIR is set.
npx gondolin build --init-config > ~/.pi/agent/gondolin-build-config.json
pi --update-gondolin-image --print
```

Extension never creates or rewrites config. Relative paths resolve against config file directory. Gondolin supplies defaults and validation; `alpine.rootfsPackages` replaces package list rather than adding to it. Legacy cache entries stay untouched.

Pi startup never builds images or repairs cache:
- No config: default Gondolin image, including environment overrides; no custom-image warning.
- Valid config, no image: default image plus update warning.
- Valid cached custom image: use it, even when stale. Changed parsed config or Gondolin version warns on each startup. Formatting, timestamps, and changes to referenced files do not mark image stale.
- Invalid or unreadable config: warning; use valid old image if available, otherwise default.
- Broken image or cache pointer: error; use default, leave cache untouched.

Missing or stale custom image warns: "Warning: Custom Gondolin image is outdated. Run `pi --update-gondolin-image --print` to rebuild it."

`pi --update-gondolin-image --print` always rebuilds valid config, even when unchanged. Missing config does nothing; invalid config fails update. Any live Gondolin session blocks rebuild, including unrelated sessions and VMs retained while `/sandbox` is off. Close sessions before updating. Session check uses Gondolin `listSessions()`; no usage tracking or locking.

Cache: `$XDG_CACHE_HOME/gondolin-rises/images` (default: `~/.cache/gondolin-rises/images`). Build and validate replacement before switching active pointer; remove replaced image afterward. Failed builds retain old image and remove failed build output. Pointer switch commits update. If old-image cleanup fails, update still reports success and warns with old path and error; new image stays active. Only one completed custom image remains after successful cleanup, excluding untouched legacy cache entries. Valid active custom image takes precedence over `GONDOLIN_GUEST_DIR` and `GONDOLIN_DEFAULT_IMAGE`. Removing config selects default but leaves cache untouched.

## Development

Runtime owners:
- `src/index.ts`: pi registration, events, toggle, and prompt wiring.
- `src/build-config.ts`: optional upstream image build-config loading and validation.
- `src/user-config.ts`: optional runtime mount config typing, validation, and path resolution.
- `src/images.ts`: image build, validation, cache selection, and atomic activation. Startup never writes cache.
- `src/operations.ts`: VM filesystem and bash adapters; current path policy unchanged.
- `src/sandbox.ts`: VM startup, reuse, and idempotent shutdown, including pending startup.

Checks:

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run format:check
```

Tests use Node.js `node:test`, written in TypeScript beside source files in `src/`. Node.js runs tests with native type stripping; `npm run typecheck` checks source, tests, and fixtures. Tests and fixtures stay out of published package. Integration test executes real pi tools with fake Gondolin VM and isolated fake executable prerequisites; no LLM calls, image downloads, or QEMU needed. Development pins pi `1.3.0` as tested API baseline; host supplies pi at runtime, following pi's wildcard peer convention. Other dependencies use version ranges. Runtime and pi API dependency updates need human review.

## License

[Apache-2.0](LICENSE), matching upstream Gondolin example.
