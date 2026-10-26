# Spec

## General
pi extension providing configurable pi sandbox via Gondolin.

Requires Node.js 24 or newer.

Only runtime dependency: Gondolin. pi supplies extension API.

## Configuration

### Build config

Optional `gondolin-build-config.json` in pi config directory uses upstream Gondolin build-config format, defaults, and validation. Resolve relative paths against config file directory. Never create or rewrite config.

- Missing build config uses Gondolin default image, including environment overrides, without custom-image warning. Leave existing cache untouched.
- Pi startup never builds custom images or repairs cache. Custom images live in `$XDG_CACHE_HOME/gondolin-rises/images`, falling back to `~/.cache/gondolin-rises/images`. Use image named by active cache pointer; do not discover or promote cached images. Valid custom image takes precedence over `GONDOLIN_GUEST_DIR`.
- Invalid or unreadable build config during normal startup shows warning. Use valid active custom image if available; otherwise use Gondolin default image.
- Missing active image or pointer uses Gondolin default image. Invalid or unreadable pointer, or broken active image, shows actionable error and counts as no custom image; use default. Leave cache untouched.
- With valid build config, missing or outdated custom image warns on every startup: "Warning: Custom Gondolin image is outdated. Run `pi --update-gondolin-image --print` to rebuild it." Keep using valid outdated image; use default if none exists.
- Freshness compares parsed config and Gondolin version. Ignore file timestamps, formatting, and changes to files referenced by config.
- `pi --update-gondolin-image --print` without build config reports nothing to build. Invalid or unreadable build config fails update without changing active image. Valid build config always rebuilds, even when active image matches.
- Before rebuild, use Gondolin `listSessions()`. Any live Gondolin session blocks rebuild with actionable error, regardless of image or owning tool. Session-query failure blocks rebuild. No extension-owned usage tracking or locking; sessions starting after check are accepted race.
- Before build, check host requirements for selected config and report all missing dependencies with install guidance; do not start build if any are missing.
- Build into temporary directory while retaining old image. Validate completed image before switching active pointer; delete replaced image only after switch. Failed build retains old active image and removes temporary build output. Retain only one completed custom image after successful rebuild. No automatic cleanup of legacy cache entries.
- Before starting VM, check required host runtime dependencies for selected image and report all missing dependencies with install guidance. Copy-on-write root disk needs `qemu-img`; QEMU backend also needs architecture-matched `qemu-system-*`. `GONDOLIN_VMM=krun` does not require QEMU system emulator.

### User config

Optional `gondolin-rises.json` in pi config directory controls extra host mounts, separate from image build config. Never create or rewrite config. Missing file means no extra mounts. Require `_version: 0` and `mounts` array of relative directory paths. Resolve each path against config file directory; reject absolute paths and missing/non-directory paths. Allow symlinks only when mount root resolves inside user's home directory or host temp directory, including either directory itself. Mount each resolved host directory at same absolute guest path. No symlink warnings or recursive symlink scan. Invalid or unreadable config fails sandbox startup with actionable error; never start VM with partial mount list.

Optional `secrets` object maps guest environment variable names to `{ hostEnv, hosts }`. `hostEnv` names host environment variable holding secret value; never store secret values in config. `hosts` lists host patterns where Gondolin may substitute that secret. Read host values at sandbox startup; unset or empty value fails startup with actionable error and never starts VM. Use `createHttpHooks` for these definitions and pass both returned `env` placeholders and `httpHooks` to VM. Never pass real secret values into guest environment. Do not configure global `allowedHosts` or other `createHttpHooks` options. Per-secret `hosts` limits secret substitution only; it does not restrict general network access. Invalid or unreadable config fails sandbox startup with actionable error.


### Sandbox instructions

Optional `sandboxAgentsFile` in `gondolin-rises.json` names relative Markdown file; resolve against config directory. Configured missing, non-file, or unreadable target fails sandbox startup with actionable error. Unset field preserves normal global instructions. Never create or rewrite instruction files; no guest mount or image rebuild required.

Read replacement at extension startup. Replace normal global instruction entry from pi config directory; never append or supply original global contents alongside replacement. Keep all project and ancestor instruction entries unchanged. Empty replacement suppresses normal global instructions too. Instruction selection stays fixed across `/sandbox` toggles; toggling changes execution only, not instructions.

## Feature: Home path
Guest `HOME` matches host `os.homedir()`. Guest home directory exists. Sandbox shell startup preserves this value, so bare `~` resolves to same absolute path as on host. Applies to default and custom images; no build-config change or image rebuild required.

Home path matching does not change guest username, UID, or GID. Never mount host home automatically. Only CWD and configured mounts expose host files; unmounted home paths remain guest-local. Existing tool path restrictions and mount containment stay unchanged. Never forward full host environment.

## Feature: Toggle
Sandbox starts on. `/sandbox` toggles on or off after agent becomes idle.

On: `read`, `write`, `edit`, `bash`, and user `!` commands run inside Gondolin. Mount host session CWD at same absolute guest path; also mount each directory listed in `gondolin-rises.json` at same absolute guest path. CWD and configured mounts must have actual provider roots inside canonical user home or host temp directory, including either directory itself; validate before VM starts. Outside roots fail startup with actionable error; never start VM with partial mount list. All tools may read and write through configured mounts. Gondolin enforces per-mount host symlink containment on access; symlinks escaping mount root cannot access host targets, even within home. Guest filesystem outside home remains accessible. Model prompt identifies VM and says host CWD is mounted there.

Off: those tools and commands run on host. Model prompt stays unchanged. Status and notification show sandbox state, with host execution warning when off.

Keep VM while off; reuse when on. Close on session shutdown, including pending startup. Concurrent shutdown closes once. Shutdown prevents later VM startup and publication. Failed VM startup must not fall back to host; allow retry before shutdown.

Canceled bash commands must not start when signal already aborted. Forward later cancellation and timeout to VM execution.
