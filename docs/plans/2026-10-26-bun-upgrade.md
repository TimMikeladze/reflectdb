# Update Bun versions

Use Bun 1.4.4, the latest stable release verified against GitHub and npm on
2026-10-26. Keep the existing dependency range style and Docker Alpine images.

- [x] Update both stages in the four example Dockerfiles to `1.4.4-alpine`.
- [x] Update all six `@types/bun` declarations to `^1.4.4` and regenerate their
      existing lockfiles with Bun 1.4.4. Update the README development prerequisite.
- [x] Verify frozen installs, type checking, lint, the package build and tests
      with Bun 1.4.4. Check the Docker tag exists and scan for stale pins.

CI already selects `latest`. Preserve comments and errors describing when Bun
APIs were introduced; those are compatibility facts rather than version pins.

Verified with Bun 1.4.4: 1,156 tests passed, 23 skipped; type checking, package
build, exports and Node consumer checks passed. Lint reported 0 errors and
56 warnings. All four Docker images built and served their page and JavaScript
bundle with HTTP 200. Independent review found no actionable issues.

The htmx and UI installs used a one-time `--minimum-release-age-excludes`
override for the Bun type packages. Normal frozen installs then passed;
the release-age configuration was preserved.

## Deploy examples to Fly

- [x] Deploy the updated htmx-todos and Huddle images to their existing Machines.
- [x] Deploy Tetris and Whiteboard after the user approved resetting their demo
      databases. Both use restart-only root filesystem storage.
- [x] Verify the Bun version on each deployed Machine and request each public
      page and JavaScript bundle.

Use the repository root as the build context and the example's Dockerfile and
Fly config. Keep the existing Machine count with `--ha=false --update-only`.

htmx-todos (`876e72b0469698`) and Huddle (`2869e50c36dd18`) now report Bun 1.4.4
via `flyctl machine exec`. Their public pages and JavaScript bundles returned
HTTP 200 after deployment.

Tetris and Whiteboard images were built and pushed before deployment. The user
approved resetting their demo data on 2026-10-26:

- `registry.fly.io/reflectdb-tetris:bun-1.4.4-ce577840`
- `registry.fly.io/reflectdb-whiteboard:bun-1.4.4-ce577840`

Tetris (`87e123a0022368`) and Whiteboard (`e8263e6c325768`) were deployed using
those prepared images. Final live checks confirmed all four apps report Bun
1.4.4 and return HTTP 200 for their public page and JavaScript bundle. Each app
still has one Machine.
