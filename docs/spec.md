# Spec

## General
pi extension providing configurable pi sandbox via Gondolin.

Requires Node.js 24 or newer.

Only runtime dependency: Gondolin. pi supplies extension API.

## Configuration
Store configuration in `gondolin-rises.json` in pi config directory. Supported version: `0`; reject missing or other versions. Create version-zero file if absent. Ignore unknown fields without rewriting existing file.
- `image.packages` lists extra Alpine packages for a cached custom guest image. Missing list means empty list.
- Empty package list uses Gondolin default image, including environment overrides; image update does nothing.
- Pi startup never builds custom images or repairs cache. With packages configured, use image named by active cache pointer. Missing pointer uses Gondolin default image and warns with update command; do not discover or promote cached images. Invalid or unreadable pointer, or broken active image, blocks VM startup with actionable error. Leave cache untouched.
- If active custom image does not match current package list or Gondolin version, keep using it and warn on every startup with update command.
- `pi --update-gondolin-image` always rebuilds custom image from current config, including when config matches active image. Before build, check host requirements and report all missing dependencies with install guidance; do not start build if any are missing. Switch cache pointer only after successful build; keep older cached images.
- Before starting VM, check required host runtime dependencies and report all missing dependencies with install guidance. Default copy-on-write root disk needs `qemu-img`; default QEMU backend also needs architecture-matched `qemu-system-*`. `GONDOLIN_VMM=krun` does not require QEMU.


## Feature: Toggle
Sandbox starts on. `/sandbox` toggles on or off after agent becomes idle.

On: `read`, `write`, `edit`, `bash`, and user `!` commands run inside Gondolin. Model prompt identifies VM workspace.

Off: those tools and commands run on host. Model prompt stays unchanged. Status and notification show sandbox state, with host execution warning when off.

Keep VM while off; reuse when on. Close on session shutdown, including pending startup. Concurrent shutdown closes once. Shutdown prevents later VM startup and publication. Failed VM startup must not fall back to host; allow retry before shutdown.

Canceled bash commands must not start when signal already aborted. Forward later cancellation and timeout to VM execution.
