# Shared ReflectDB skill

Keep one portable Agent Skills entrypoint at `skills/reflectdb/SKILL.md`.
Claude Code discovers it through `.claude/skills/reflectdb`; Codex discovers it
through `.agents/skills/reflectdb`. Both paths link to the same directory.
Use standard `name` and `description` frontmatter without runtime-specific
argument substitution, tools, or dependencies on other installed skills.

The skill supports building apps with ReflectDB and debugging existing sync
integrations. Keep the workflow and invariants in the entrypoint; put a typed
integration example in a relative reference so copying the skill folder works
outside this repository. Prefer the installed package's types over examples
from a different version. Include the skill in the npm package.

Verify frontmatter, relative references, both discovery links, npm package
contents, and the example's types. Run lint and the project type check. Document
the native invocations: `/reflectdb` in Claude Code and `$reflectdb` in Codex.
Do not claim that a model session has exercised the command unless it has.

## Landing page documentation

Publish a curated root `llms.txt` on the landing page, plus `llm.txt` as an
alias. Generate `llms-full.txt` and Markdown copies of the README, feature docs,
and shared skill at build and dev startup. Keep the index in the repository
root so repository readers can discover it too. Link these resources in the
page head and footer. Serve them as static files without a JavaScript runtime.

Verify generated local links, source freshness, the landing build, and HTTP
responses from the production preview. These are documentation changes;
deployment remains a separate action.
