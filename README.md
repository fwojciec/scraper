# scraper

Drive a running Chrome tab over the DevTools Protocol. Seven commands — `tabs`, `navigate`,
`snapshot`, `eval`, `wait`, `upload`, `screenshot` — address a specific tab by its `targetId`. The
user keeps browsing; scraper attaches, acts, detaches. No semantic action layer: write raw JS in
`eval` and let `$ref("eN")` resolve element handles minted by the ARIA snapshot.

## Requirements

- Deno 2+
- A running Chrome with remote debugging enabled (`--remote-debugging-port=0`). Scraper does not
  launch Chrome.

## Install

Run from source:

```sh
deno task dev -- tabs
```

Or compile a single binary:

```sh
deno compile --allow-net --allow-read --allow-write --allow-env --allow-run \
  --output scraper src/main.ts
./scraper tabs
```

By default scraper reads the stable-channel user data directory. Override with:

- `SCRAPER_CHROME_CHANNEL` — `stable` (default) | `beta` | `dev` | `canary`
- `SCRAPER_USER_DATA_DIR` — absolute path to a custom Chrome profile directory

## Quick start

```sh
# 1. list tabs, copy a targetId prefix
scraper tabs
# 4AE7B2C9E1D4F0A2B8C6E1F3A5D9B7C2	https://example.com/	"Example Domain"

# 2. navigate (auto-snapshots)
scraper navigate --tab 4AE7B2C9 https://example.com/form

# 3. read ~/.scraper/s{N}.yaml, pick a ref, act
scraper eval --tab 4AE7B2C9 '$ref("e3").click()'

# 4. refresh refs after a DOM mutation
scraper snapshot --tab 4AE7B2C9
```

Full command reference: [docs/cli.md](docs/cli.md).

## Development

```sh
deno task test              # unit tests (fast, no Chrome)
deno task test:integration  # integration tests (real Chrome, real HTTP)
deno task ci                # fmt --check + lint + check + both test suites
```

Internals, module boundaries, and the dependency rule: [docs/architecture.md](docs/architecture.md).

## For LLM agents

[SKILL.md](SKILL.md) is a skill document aimed at AI agents driving scraper directly. It covers the
`$ref` contract, auto-snapshot rule, stale-ref recovery loop, and common eval recipes.

## Status

v0.1 — the minimal "Tier B" command surface. No click/fill/submit/select primitives; use `eval` with
raw JS. Stale refs throw a canonical error pointing the caller at `scraper snapshot`.
