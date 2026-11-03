# Jady

A local-first desktop app for everything you write, learn and keep track of, with AI built in. Notes, study material, to-dos and life records live in one encrypted library on your own computer. AI takes part everywhere, but any change it wants to make to existing content becomes a proposal that you confirm first.

The author is using it personally for now; it will be released later as free, open-source software. macOS only for now.

## Status

| Phase | Scope | Status |
| --- | --- | --- |
| P0, P0.5 | Developer tools, spikes, storage format, design | Done |
| P1–P3 | Core app, organising and capture, learning and AI | Done |
| P4 | Life templates, calendar, timeline, graph, map, whiteboard, password vault, sync between computers, scheduled AI tasks | Done |
| P5 | Open-source release | Guide, English interface and documents done; licence is AGPL-3.0; signing, updates, icon and publishing wait on the owner, see [the checklist](docs/release/checklist.md) |

Using it: [getting started](docs/user/getting-started.en.md) ([中文](docs/user/getting-started.md)). Extending it: [docs/extending](docs/extending/README.md). What is next: [roadmap](docs/roadmap.md).

## Documents

The design documents are written in Chinese. Read them in this order:

| File | Contents |
| --- | --- |
| [CLAUDE.md](CLAUDE.md) | Working conventions and hard rules (AI access, privacy, permissions) |
| [docs/01-prd.md](docs/01-prd.md) | Product requirements, v1.4, with numbered requirements |
| [docs/02-architecture.md](docs/02-architecture.md) | Overall structure, technology choices, decisions made |
| [docs/03-modules.md](docs/03-modules.md) | Each module's responsibilities, data structures and acceptance criteria |
| [docs/04-phases.md](docs/04-phases.md) | Steps and completion criteria for each phase |
| [docs/05-design.md](docs/05-design.md) | Design guidelines: how it works and how it looks |

Also:

- [docs/format-spec.md](docs/format-spec.md): the storage format, including encryption envelopes and item files.
- [docs/spikes/](docs/spikes/): findings from technical spikes (CRDT, search, platform differences, Claude Code integration, performance, UI components).
- [docs/testing.md](docs/testing.md): how tests are organised.

## Technology

- Core in Rust. Encryption uses established libraries only, never home-made cryptography. Items are stored with Loro (a CRDT); the index uses SQLite.
- Desktop shell in Tauri 2; interface in TypeScript and React, built with Vite.
- UI building blocks: React Aria, Lucide icons and dockview, each wrapped in our own layer.
- AI is reached only through a replaceable provider interface. Everyone uses their own account or key. The app never offers a Claude sign-in and never stores anyone's sign-in credentials.

## Repository layout

| Path | Contents |
| --- | --- |
| `crates/` | The Rust core, split into crates by module (`dem-core` service facade, `dem-store` storage, `dem-crypto` encryption, `dem-ai-gateway` AI gateway, and others) |
| `apps/desktop/` | The desktop app: Tauri shell and React interface |
| `xtask/` | Repository automation: `cargo xtask ci` and the layer check |
| `spikes/` | Throwaway prototypes from technical spikes; not part of the app |
| `testdata/` | Test data and evaluation sets |

## Development

You need:

- Rust. The version is pinned in `rust-toolchain.toml`; rustup installs it automatically.
- Node.js 24 or newer, and pnpm 12.

macOS is the main platform. Every push runs the full checks on macOS and Windows in CI. Linux support comes later.

Run the same checks as CI locally (Rust formatting, clippy, tests, layer check, dependency audit, frontend checks):

```bash
cargo xtask ci
```

Start the development build:

```bash
cd apps/desktop && pnpm install && pnpm tauri dev
```

The first run downloads the bundled fonts (LXGW WenKai, Archivo, JetBrains Mono; about 27 MB) and verifies their SHA-256. Later runs use the local copies.

Conventions: code identifiers and comments are in English, commit messages in Chinese, and the main branch is `main`.

## Licence

[GNU Affero General Public License v3.0](LICENSE) only. Third-party content is listed in [NOTICE.md](NOTICE.md).
