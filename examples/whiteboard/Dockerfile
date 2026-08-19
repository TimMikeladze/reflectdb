FROM oven/bun:1.3.14-alpine AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# better-auth is the one dependency the root lockfile does not carry, and it
# has to resolve from the example directory so the browser bundle and the
# server agree on a single copy. react and drizzle-orm stay at the root for the
# same reason in reverse: src/react imports them from /app/node_modules, and a
# second copy here would give the page two Reacts.
COPY examples/whiteboard/package.json ./examples/whiteboard/
RUN cd examples/whiteboard && bun install

COPY src ./src
COPY examples/whiteboard ./examples/whiteboard
RUN bun build examples/whiteboard/render.tsx \
	--target=browser \
	--minify \
	--outfile=examples/whiteboard/app.js

FROM oven/bun:1.3.14-alpine

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/examples/whiteboard ./examples/whiteboard

ENV NODE_ENV=production \
	PORT=8080 \
	WHITEBOARD_BASE_URL=https://reflectdb-whiteboard.fly.dev \
	WHITEBOARD_DB_PATH=/app/examples/whiteboard/whiteboard.db \
	WHITEBOARD_AUTH_DB_PATH=/app/examples/whiteboard/auth.db

EXPOSE 8080
WORKDIR /app/examples/whiteboard
CMD ["bun", "server.tsx"]
