# GitHub CLI auth inside Gondolin

## Finding

`gh` can run inside a Gondolin guest, but host `gh auth login` state does not cross into the VM automatically. The linked `magic-git-bash.ts` example keeps `gh` and its credentials on the host, then exposes cloned repositories through a read-only VFS mount.

For actual `gh` commands inside the guest, install `gh` there and use Gondolin secret injection for a host-supplied token. This keeps the token value out of guest memory and files, but gives guest code the token's GitHub capability through allowed requests. It is not safe to expose a broad personal token to untrusted agent code.

## What `magic-git-bash.ts` does

The example runs host-side `gh repo list` and `gh repo clone` using `execFileSync`. It clones lazily into a host temporary directory, then exposes repository files under `/git` through `ReadonlyProvider` and a custom VFS provider. Guest code can browse files, but cannot run `gh` or mutate those clones. Host `gh` needs to be installed and authenticated. Guest GitHub network access is not needed for this path.

This is the best fit for read-only repository browsing. It does not support guest-side `gh issue`, `gh pr`, API calls, pushes, or other GitHub actions.

## Run `gh` in the guest with host auth

Install `gh` in the guest image. Install `git` too for clone/fetch/push. The GitHub CLI accepts `GH_TOKEN` (preferred over `GITHUB_TOKEN`) for headless authentication. `gh auth token` can read the active host login token without copying the host's `gh` config into the VM.

Use Gondolin's `createHttpHooks` to expose a placeholder in the guest environment. Gondolin replaces that placeholder with the real token only in outbound request headers to configured hosts:

```ts
import { execFileSync } from "node:child_process";
import { createHttpHooks, VM } from "@earendil-works/gondolin";

const token = execFileSync(
  "gh",
  ["auth", "token", "--hostname", "github.com"],
  { encoding: "utf8" },
).trim();

const { env, httpHooks } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GH_TOKEN: {
      value: token,
      hosts: ["api.github.com"],
    },
  },
});

const vm = await VM.create({ httpHooks, env });
```

Pass **both** `httpHooks` and `env`. Do not pass the raw token through `VM.create({ env: { GH_TOKEN: token } })`; that makes it readable inside the guest. Keep `allowedHosts` narrow. For Git over HTTPS, also allow `github.com` in both the global allowlist and the secret's `hosts`, then configure Git with `gh auth setup-git --hostname github.com`. Gondolin supports placeholder replacement inside Basic authorization headers used by Git.

`GH_TOKEN` authenticates `gh` API requests to `api.github.com`. GitHub Enterprise Server uses `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN` and the matching enterprise host.

## Other workable approaches

1. **Host-side broker.** Run selected `gh` commands or API calls on the host and return structured results. The Magic Git VFS is a file-reading broker. For issues, PRs, or writes, explicit extension tools with an operation and repository allowlist keep host credentials on the host. Do not turn arbitrary guest shell input into arbitrary host `gh` commands.
2. **SSH egress for Git transport.** Gondolin 0.13.0 supports guest-to-upstream SSH through a host-side proxy using the host SSH agent or a configured private key. Allow only `github.com`; use `execPolicy` to restrict repositories or deny `git-receive-pack` (push). This can authenticate Git operations without placing an SSH key in the guest. It does not authenticate `gh` REST/GraphQL requests, so it is not a full replacement for `GH_TOKEN`.
3. **Separate guest login.** `gh auth login` can authenticate in the guest with a device flow or token. This is independent of host login. The token is stored in the guest credential store or, when unavailable, may fall back to a plaintext config file. Treat this as exposing the credential to guest code; avoid for untrusted workloads.
4. **Mount host `~/.config/gh`.** Technically possible only when the needed credentials are in files. It may fail when host `gh` uses an OS credential store, and it exposes any stored token to the guest. Do not use this for an untrusted sandbox.

## Recommendation for this project

For browsing external repositories, adapt the read-only `/git` VFS pattern from `magic-git-bash.ts`. It reuses host authentication without giving the guest a token.

For `gh` commands from sandboxed `bash`, install `gh` in the guest and add `httpHooks` plus the returned `env` to `VM.create`. Prefer a short-lived GitHub App installation token limited to the needed repositories and permissions, rather than the host's general `gh` token. Gondolin's host allowlist is hostname-based; secret injection does not make a token read-only. Guest code can still use an injected token to perform any GitHub operation that token permits.

Current `index.ts` passes only VFS options to `VM.create`; it does not configure `httpHooks` or secret env. `package-lock.json` pins Gondolin 0.13.0, which includes the documented secret and SSH egress features.

## Sources

- [Gondolin `magic-git-bash.ts`](https://github.com/earendil-works/gondolin/blob/main/host/examples/magic-git-bash.ts)
- [Gondolin secrets handling](https://github.com/earendil-works/gondolin/blob/v0.13.0/docs/secrets.md)
- [Gondolin security design](https://github.com/earendil-works/gondolin/blob/v0.13.0/docs/security.md)
- [Gondolin SSH egress](https://github.com/earendil-works/gondolin/blob/v0.13.0/docs/ssh.md)
- [Gondolin VFS providers](https://github.com/earendil-works/gondolin/blob/v0.13.0/docs/vfs.md)
- [GitHub CLI environment variables](https://cli.github.com/manual/gh_help_environment)
- [`gh auth login`](https://cli.github.com/manual/gh_auth_login)
- [`gh auth token`](https://cli.github.com/manual/gh_auth_token)
- [`gh auth setup-git`](https://cli.github.com/manual/gh_auth_setup-git)
- [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
