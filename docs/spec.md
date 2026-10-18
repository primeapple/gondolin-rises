# Spec

## General
pi extension providing configurable pi sandbox via Gondolin.

Requires Node.js 24 or newer.

Only runtime dependency: Gondolin. pi supplies extension API.

## Configuration
Store configuration in `gondolin-rises.json` in pi config directory. Configuration version starts at `0`. Create file if it does not exist.
- `image.packages` is a list of packages to install in image.

## Feature: Toggle
Sandbox starts on. `/sandbox` toggles on or off after agent becomes idle.

On: `read`, `write`, `edit`, `bash`, and user `!` commands run inside Gondolin. Model prompt identifies VM workspace.

Off: those tools and commands run on host. Model prompt stays unchanged. Status and notification show sandbox state, with host execution warning when off.

Keep VM while off; reuse when on. Close on session shutdown. Failed VM startup must not fall back to host; allow retry.
