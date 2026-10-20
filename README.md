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

Set `image.packages` in `gondolin-rises.json` in Pi's config directory:

```json
{
  "version": 0,
  "image": { "packages": ["git", "file"] }
}
```

Packages add to Gondolin's default Alpine set. Pi startup never builds custom images. It uses the active cached image; if none exists, it uses Gondolin's default image and warns with `pi --update-gondolin-image`. If package settings or Gondolin version changed, startup keeps using the active image and shows the same warning.

Run `pi --update-gondolin-image` from the shell to rebuild the custom image using current settings. This always rebuilds, so it can also pick up newer Alpine packages. Pi switches to the new image only after a successful build; older images remain in `$XDG_CACHE_HOME/gondolin-rises/images` (default: `~/.cache/gondolin-rises/images`). Builds need `mke2fs` from `e2fsprogs` and network access. While packages are configured, the active custom image takes precedence over `GONDOLIN_GUEST_DIR` and `GONDOLIN_DEFAULT_IMAGE`.


## License

[Apache-2.0](LICENSE), matching upstream Gondolin example.
