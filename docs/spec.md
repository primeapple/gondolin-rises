# Spec

## General
pi extension providing configurable pi sandbox via Gondolin.

Requires Node.js 24 or newer.

Only runtime dependency: Gondolin. pi supplies extension API.

## Configuration
Optional `gondolin-build-config.json` in pi config directory uses upstream Gondolin build-config format, defaults, and validation. Resolve relative paths against config file directory. Never create or rewrite config.

- Missing config uses Gondolin default image, including environment overrides, without custom-image warning. Leave existing cache untouched.
- Pi startup never builds custom images or repairs cache. Custom images live in `$XDG_CACHE_HOME/gondolin-rises/images`, falling back to `~/.cache/gondolin-rises/images`. Use image named by active cache pointer; do not discover or promote cached images. Valid custom image takes precedence over `GONDOLIN_GUEST_DIR`.
- Invalid or unreadable config during normal startup shows warning. Use valid active custom image if available; otherwise use Gondolin default image.
- Missing active image or pointer uses Gondolin default image. Invalid or unreadable pointer, or broken active image, shows actionable error and counts as no custom image; use default. Leave cache untouched.
- With valid config, missing or outdated custom image warns on every startup: "Warning: Custom Gondolin image is outdated. Run `pi --update-gondolin-image --print` to rebuild it." Keep using valid outdated image; use default if none exists.
- Freshness compares parsed config and Gondolin version. Ignore file timestamps, formatting, and changes to files referenced by config.
- `pi --update-gondolin-image --print` without config reports nothing to build. Invalid or unreadable config fails update without changing active image. Valid config always rebuilds, even when active image matches.
- Before rebuild, use Gondolin `listSessions()`. Any live Gondolin session blocks rebuild with actionable error, regardless of image or owning tool. Session-query failure blocks rebuild. No extension-owned usage tracking or locking; sessions starting after check are accepted race.
- Before build, check host requirements for selected config and report all missing dependencies with install guidance; do not start build if any are missing.
- Build into temporary directory while retaining old image. Validate completed image before switching active pointer; delete replaced image only after switch. Failed build retains old active image and removes temporary build output. Retain only one completed custom image after successful rebuild. No automatic cleanup of legacy cache entries.
- Before starting VM, check required host runtime dependencies for selected image and report all missing dependencies with install guidance. Copy-on-write root disk needs `qemu-img`; QEMU backend also needs architecture-matched `qemu-system-*`. `GONDOLIN_VMM=krun` does not require QEMU system emulator.


## Feature: Toggle
Sandbox starts on. `/sandbox` toggles on or off after agent becomes idle.

On: `read`, `write`, `edit`, `bash`, and user `!` commands run inside Gondolin. Mount host session CWD at same absolute guest path; reject host filesystem root as CWD. Model prompt identifies VM and says host CWD is mounted there.

Off: those tools and commands run on host. Model prompt stays unchanged. Status and notification show sandbox state, with host execution warning when off.

Keep VM while off; reuse when on. Close on session shutdown, including pending startup. Concurrent shutdown closes once. Shutdown prevents later VM startup and publication. Failed VM startup must not fall back to host; allow retry before shutdown.

Canceled bash commands must not start when signal already aborted. Forward later cancellation and timeout to VM execution.
