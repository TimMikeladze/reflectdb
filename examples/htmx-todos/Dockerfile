# Bun 1.4 — the example's bun.lock is lockfileVersion 2, which 1.3.x cannot
# parse. Keep this in step with whatever wrote examples/htmx-todos/bun.lock.
FROM oven/bun:1.4.0-alpine AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY examples/htmx-todos ./examples/htmx-todos

# htmx is a dependency of the example, not of reflectdb, so it installs here.
WORKDIR /app/examples/htmx-todos
RUN bun install --frozen-lockfile
RUN bun build client.ts --target=browser --minify --outfile=client.js

FROM oven/bun:1.4.0-alpine

WORKDIR /app
COPY --from=build /app/src ./src
COPY --from=build /app/examples/htmx-todos/*.ts ./examples/htmx-todos/
COPY --from=build /app/examples/htmx-todos/client.js ./examples/htmx-todos/
COPY --from=build /app/examples/htmx-todos/index.html ./examples/htmx-todos/
COPY --from=build /app/examples/htmx-todos/package.json ./examples/htmx-todos/

ENV NODE_ENV=production \
	PORT=8080

EXPOSE 8080
WORKDIR /app/examples/htmx-todos
CMD ["bun", "server.ts"]
