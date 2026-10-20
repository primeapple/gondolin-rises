# Gondolin sandbox packages and images

## Scope

This report follows Gondolin `v0.13.0`, the version pinned in this repository's `package-lock.json`. The package range in `package.json` is `^0.13.0`; upstream behavior may change in later releases.

## Short answer

- Default guest image is Alpine Linux. Its OS package manager is APK (`apk`).
- Add OS packages at image-build time with `alpine.rootfsPackages`. Package names must exist in the selected Alpine branch and architecture.
- Gondolin's v0.13.0 image builder reads APK indexes, downloads `.apk` archives, resolves dependencies, then extracts files. It does not run `apk add` as its install step.
- For Debian or Ubuntu and `apt`, build an OCI image with the packages already installed, then configure Gondolin to use it as the rootfs.
- For this Pi sandbox, add `git` and `file` to the existing base set. Add other tools only when a workload needs them.

## Package manager and available packages

The built-in `alpine-base:latest` image is Alpine-based. Alpine's package manager is APK; its package search lists packages by Alpine branch, repository, and architecture. Gondolin's default Alpine minirootfs enables both `main` and `community` repositories. Package availability therefore depends on the selected Alpine release and target architecture, not just the package name.

In Gondolin's build config, `alpine.rootfsPackages` installs packages into the guest root filesystem. `alpine.initramfsPackages` is for packages needed in the boot-time initramfs; it is normally empty for a non-OCI Alpine image. The default Alpine version is `3.23.0`, with branch derived as `v3.23`. The standard image already includes `npm` and `uv`; `py3-pip` is an optional APK package used by Gondolin's LLM example.

The package installer in v0.13.0 is a custom APK archive resolver: it reads `/etc/apk/repositories` and APKINDEX files, resolves dependencies, downloads package archives, and extracts their contents. It does not perform a normal `apk add` transaction or run package install hooks. The extraction code skips APK metadata files and does not update `/lib/apk/db/installed`, so do not assume the guest's `apk` database accurately lists packages added through `rootfsPackages`. Prefer baking repeatable OS packages into an image. `postBuild.commands` runs shell commands in a chroot after package extraction and can perform extra setup.

Treat `rootfsPackages` entries as package names, not reliable version pins: the v0.13.0 resolver normalizes version operators away and selects versions from the APKINDEX for the configured branch. Pin the Alpine release and retain the built assets or build ID when you need to reuse an exact image. In v0.13.0, `alpine.mirror` changes the minirootfs tarball URL; package downloads still use repository URLs from the extracted `/etc/apk/repositories`.

## Recommended packages

Gondolin's generated config and published `alpine-base` image include this baseline:

```text
linux-virt, rng-tools, bash, ca-certificates, curl, e2fsprogs,
e2fsprogs-extra, nodejs, npm, uv, python3, openssh
```

For this repository's sandbox, add:

- `git` for normal repository operations; it is not in the built-in list.
- `file` for `src/index.ts` image MIME detection. That code returns no MIME type if `file` is missing; the built-in list does not include it.

Useful optional tools include `ripgrep` and `jq`. Add compiler toolchains such as `build-base` only for tasks that compile native code. Gondolin's own examples add workload-specific sets rather than one large universal image: Chromium packages for browser automation, Docker packages for a Docker guest, and `py3-pip` plus a `postBuild` pip command for an LLM CLI.

Do not replace the generated `rootfsPackages` array with only add-ons. When the field is set, it replaces the default list rather than appending to it. Keep at least the configured kernel package (`linux-virt` by default); this Pi extension also requires `bash` because it runs `/bin/bash -lc`. Start from `gondolin build --init-config` and add packages to that list. In v0.13.0, the generated config and `images/alpine-base.json` include the 12-package list above; the builder's fallback list for hand-written configs that omit `rootfsPackages` omits `e2fsprogs`, `e2fsprogs-extra`, and `openssh`. Using the generated config avoids that difference.

Example workflow:

```sh
gondolin build --init-config > build-config.json
# Add "git" and "file" to the generated alpine.rootfsPackages array.
gondolin build --config build-config.json --output ./gondolin-assets
GONDOLIN_GUEST_DIR="$PWD/gondolin-assets" pi
```

The standard Alpine package search is [pkgs.alpinelinux.org/packages](https://pkgs.alpinelinux.org/packages). Check the branch and architecture used by the image before selecting a package.

## Other image settings

- **Architecture and Alpine release:** Set `arch` to `aarch64` or `x86_64`; keep it compatible with the host/backend. Set `alpine.version` and, when needed, `alpine.branch` or `alpine.mirror`.
- **Rootfs size:** `rootfs.sizeMb` sets build-time size; otherwise Gondolin calculates it. Runtime `rootfs.size` can grow the disk without rebuilding, but needs `resize2fs` in the guest (`e2fsprogs-extra`, included in the built-in baseline).
- **Rootfs write mode:** `runtimeDefaults.rootfsMode` can set `cow`, `memory`, or `readonly`. `cow` is the documented default and gives each VM a disposable writable overlay. Use `readonly` for a stricter base when tools can write to mounted paths instead. The Pi extension mounts the project at `/workspace`; those host-backed files persist separately from the guest rootfs. Packages installed after boot do not become part of the base image and are lost with the VM.
- **Post-build setup:** `postBuild.copy` copies files into the rootfs. `postBuild.commands` runs commands in order inside the image chroot, after APK archives are extracted; upstream's LLM example installs Python packages this way. For Alpine builds on macOS, Gondolin uses a container for post-build commands. Native Linux builds need root privileges, and the build architecture must match the target architecture.
- **Init and environment:** `init.rootfsInit`, `init.initramfsInit`, and `init.rootfsInitExtra` customize boot behavior; use them for services or setup that must run at boot, not ordinary package installation. `env` bakes defaults into the image. Do not put secrets there; use Gondolin's runtime HTTP secret handling instead. This extension does not currently configure those secret hooks.

If you want Debian/Ubuntu packages, create an OCI image (for example, derive from `debian:bookworm-slim` and install packages in its Dockerfile), then set `oci.image`. Gondolin exports that OCI filesystem as the guest rootfs; Alpine is still used for kernel and initramfs components, and `alpine.rootfsPackages` is ignored. The OCI rootfs needs `/bin/sh` unless you supply a custom rootfs init script. In v0.13.0, `container.force` is unsupported with OCI builds, and OCI `postBuild.commands` require a native Linux host. Use a digest reference instead of a mutable tag when you need repeatable OCI inputs.

## Selecting the image in this project

When `image.packages` is non-empty, [`src/images.ts`](../../src/images.ts) adds those packages to Gondolin's default Alpine build config. Only `pi --update-gondolin-image` builds guest assets into `$XDG_CACHE_HOME/gondolin-rises/images` (default `~/.cache/gondolin-rises/images`) and atomically activates the successful build. Startup uses only the active pointer; it never builds, scans for replacement images, or repairs the cache. Missing pointer uses the default image with an update warning; invalid pointer or broken active assets block startup. Changed package settings or Gondolin version warn while keeping the active image. Explicit `sandbox.imagePath` takes precedence over `GONDOLIN_GUEST_DIR` and `GONDOLIN_DEFAULT_IMAGE`. With an empty package list, Gondolin resolves its default image and honors those environment overrides.

## Sources

- [Gondolin custom images guide, v0.13.0](https://github.com/earendil-works/gondolin/blob/v0.13.0/docs/custom-images.md)
- [Gondolin CLI image/build guide, v0.13.0](https://github.com/earendil-works/gondolin/blob/v0.13.0/docs/cli.md)
- [Gondolin default build config, v0.13.0](https://github.com/earendil-works/gondolin/blob/v0.13.0/host/src/build/config.ts)
- [Gondolin Alpine build defaults, v0.13.0](https://github.com/earendil-works/gondolin/blob/v0.13.0/host/src/build/native.ts)
- [Gondolin APK package resolver, v0.13.0](https://github.com/earendil-works/gondolin/blob/v0.13.0/host/src/alpine/packages.ts)
- [Gondolin APK archive extraction, v0.13.0](https://github.com/earendil-works/gondolin/blob/v0.13.0/host/src/alpine/tar.ts)
- [Gondolin built-in Alpine image config, v0.13.0](https://github.com/earendil-works/gondolin/blob/v0.13.0/images/alpine-base.json)
- [Gondolin examples: minimal, Chromium, Docker, and LLM images](https://github.com/earendil-works/gondolin/tree/v0.13.0/host/examples)
- [Gondolin SDK storage and image selection, v0.13.0](https://github.com/earendil-works/gondolin/blob/v0.13.0/docs/sdk-storage.md)
- [Alpine Package Keeper documentation](https://wiki.alpinelinux.org/wiki/Alpine_Package_Keeper)
- [Alpine package search](https://pkgs.alpinelinux.org/packages)
