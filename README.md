# Gondolin Rises

[pi](https://github.com/earendil-works/pi) extension running `read`, `write`, `edit`, and `bash` inside a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM.

Based on upstream [pi-gondolin.ts example](https://github.com/earendil-works/gondolin/blob/main/host/examples/pi-gondolin.ts). Entry point: [`src/index.ts`](src/index.ts).

## Requirements

- Node.js 24 or newer.
- pi installed, with `pi` on `PATH`.
- QEMU installed. See [Gondolin Quick Start](https://github.com/earendil-works/gondolin#cli-quick-start) for platform setup.

On macOS:

```sh
brew install qemu
```

On arch (x86):

```sh
pacman -S qemu-img qemu-system-x86
```

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

Set `image.packages` in `gondolin-rises.json` in Pi's config directory, then restart Pi:

```json
{
  "version": 0,
  "image": { "packages": ["git", "file"] }
}
```

Packages add to Gondolin's default Alpine set. First start builds and caches a guest image under `$XDG_CACHE_HOME/gondolin-rises/images` (default: `~/.cache/gondolin-rises/images`). Later starts reuse it; changing package list or Gondolin version builds a new image. Builds need `mke2fs` from `e2fsprogs` and network access. While packages are configured, this generated image takes precedence over `GONDOLIN_GUEST_DIR` and `GONDOLIN_DEFAULT_IMAGE`.

## License

[Apache-2.0](LICENSE), matching upstream Gondolin example.
