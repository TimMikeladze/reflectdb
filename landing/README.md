# ReflectDB landing page

```bash
bun install
bun run dev
```

Run these commands from `landing/`. Vite prints the local URL and chooses
another port if its default is occupied. `bun run build` type-checks the app
and writes the production site to `dist/`; `bun run preview` serves that build.
The Vercel project uses `landing/` as its root and `dist/` as its output.

## Claude Code and Codex skill

The hero and footer link to the shared [ReflectDB skill](../skills/reflectdb/SKILL.md)
and its [installation instructions](../README.md#claude-code-and-codex-skill).
It covers typed queries, server and client setup, storage, transports,
presence, and sync debugging.

```text
# Claude Code
/reflectdb add offline sync to this app

# Codex
$reflectdb add offline sync to this app
```

This repository's `.claude/skills/reflectdb` and `.agents/skills/reflectdb`
both link to `skills/reflectdb`. Edit that shared directory to update both.
The npm package includes the same skill folder.

## Text documentation

`bun run dev` and `bun run build` regenerate the public documentation before
starting Vite. Run `bun run docs:llms` to generate it separately.

| URL                                                             | Source                                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/llms.txt`, `/llm.txt`, `/index.md`                            | Repository [llms.txt](../llms.txt); the latter two are copies                           |
| `/llms-full.txt`                                                | Repository README, object-storage and WebRTC docs, skill, and typed integration example |
| `/docs/README.md`, `/docs/object-storage.md`, `/docs/webrtc.md` | Markdown copies of those source documents                                               |
| `/skills/reflectdb/SKILL.md`                                    | Shared skill entrypoint                                                                 |
| `/skills/reflectdb/references/integration.md`                   | Shared typed integration example                                                        |

The HTML head advertises `/llms.txt` and the Markdown alternate; the footer
links the index and full documentation. These endpoints are static files and
work without executing page JavaScript. Relative document links are resolved
to hosted Markdown files or GitHub source URLs during generation.

Generated files in `public/` are ignored by Git. Update the sources or
[scripts/llms.ts](./scripts/llms.ts), then rebuild. The focused generation check
runs from the repository root with `bun test test/landing/llms.test.ts`.
