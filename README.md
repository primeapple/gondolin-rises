# Gondolin Rises

[pi](https://github.com/earendil-works/pi) extension running `read`, `write`, `edit`, and `bash` inside a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM.

Based on upstream [pi-gondolin.ts example](https://github.com/earendil-works/gondolin/blob/main/host/examples/pi-gondolin.ts). Entry point: [`src/index.ts`](src/index.ts).

## Requirements

- Node.js 24 or newer.
- pi installed, with `pi` on `PATH`.
- QEMU system emulator matching guest architecture for the default `qemu` backend.
- `qemu-img` for the default copy-on-write root disk.
- Custom image builds need `mke2fs` from `e2fsprogs`.

On macOS:

```sh
brew install qemu e2fsprogs
```

On Debian/Ubuntu (ARM64 example):

```sh
sudo apt install qemu-system-arm qemu-utils e2fsprogs
```

On arch (x86):

```sh
pacman -S qemu-img qemu-system-x86 e2fsprogs
```

Pi checks host tools before VM startup and custom image builds, and lists missing dependencies with install hints. `GONDOLIN_VMM=krun` skips the QEMU system emulator check.

## Install

```sh
pi install git:github.com/primeapple/gondolin-rises
```

Or use a local installation via
```sh
pi --no-extensions -e /path/to/gondolin-rises
```

## Features

### Sandbox toggle

Sandbox starts on. Run `/sandbox` inside pi to toggle off or on. Toggle waits for agent to become idle.

When off, `read`, `write`, `edit`, `bash`, and user `!` commands run directly on host, without VM isolation. Status and notification show current state.

VM stays alive while off, gets reused when on, and closes on session shutdown. Failed startup never falls back to host; toggle off explicitly for host execution, or retry startup.

### Image packages

Set `image.packages` in `gondolin-rises.json` in Pi's config directory:

```json
{
  "version": 0,
  "image": { "packages": ["git", "file"] }
}
```

Packages add to Gondolin's default Alpine set. Configuration must contain `"version": 0`; other or missing versions are rejected. Unknown fields are ignored without rewriting the file.

Pi startup never builds custom images or repairs the cache. With packages configured, it uses only the active cache pointer. If that pointer is missing, Pi uses Gondolin's default image and warns with `pi --update-gondolin-image`; existing unpointed images are left alone. A corrupt or unreadable pointer, or broken active image, blocks VM startup and reports the update command. Changed package settings or Gondolin version keep the active image and show an update warning.

Run `pi --update-gondolin-image` from the shell to rebuild the custom image using current settings. This always rebuilds, so it can also pick up newer Alpine packages. Pi switches to the new image only after a successful build; older images remain in `$XDG_CACHE_HOME/gondolin-rises/images` (default: `~/.cache/gondolin-rises/images`). Builds need `mke2fs` from `e2fsprogs` and network access. While packages are configured, the active custom image takes precedence over `GONDOLIN_GUEST_DIR` and `GONDOLIN_DEFAULT_IMAGE`. Empty package list uses Gondolin's default image with environment overrides; update does nothing.

## Development

Runtime owners:
- `src/index.ts`: pi registration, events, toggle, and prompt wiring.
- `src/config.ts`: version-zero config parsing and creation.
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

Tests use Node.js `node:test`, written in TypeScript beside source files in `src/`. Node.js runs tests with native type stripping; `npm run typecheck` checks source, tests, and fixtures. Tests and fixtures stay out of published package. Integration test executes real pi tools with a fake Gondolin VM; no LLM calls, image downloads, or QEMU needed. Development pins pi `1.3.0` as tested API baseline; host supplies pi at runtime, following pi's wildcard peer convention. Other dependencies use version ranges. Runtime and pi API dependency updates need human review.

## License

[Apache-2.0](LICENSE), matching upstream Gondolin example.
