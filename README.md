# Gondolin Rises

[pi](https://github.com/earendil-works/pi) extension running `read`, `write`, `edit`, and `bash` inside a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM.

Based on upstream [pi-gondolin.ts example](https://github.com/earendil-works/gondolin/blob/main/host/examples/pi-gondolin.ts). Entry point: [`index.ts`](index.ts).

## Requirements

- Node.js 24 or newer.
- pi installed, with `pi` on `PATH`.
- QEMU installed. See [Gondolin Quick Start](https://github.com/earendil-works/gondolin#cli-quick-start) for platform setup.

On macOS:

```sh
brew install qemu
```

## Install

```sh
pi install git:github.com/<owner>/gondolin-rises
```

## License

[Apache-2.0](LICENSE), matching upstream Gondolin example.
