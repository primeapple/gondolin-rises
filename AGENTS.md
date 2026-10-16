# Spec workflow

`docs/spec.md` is single source of truth for product behavior and requirements. Read it before changing implementation. If implementation conflicts with spec, follow spec.

For behavior changes, update and settle `docs/spec.md` before touching implementation. If file does not exist, write initial spec first. Keep spec and implementation changes in separate commits; each commit contains only one kind of change.

Keep spec minimal: state required behavior and constraints; omit implementation plans and repetition. Write in smart caveman style: fewer words, same technical substance. Drop articles and filler; short words and fragments OK. Preserve technical terms. Never invent abbreviations or use causal arrows. See the `caveman` skill.

## Development

- Use test-driven development: write a failing test first, then implement the smallest change that makes it pass, then refactor.
- Use Node.js built-in test runner (`node:test`) for unit tests.

