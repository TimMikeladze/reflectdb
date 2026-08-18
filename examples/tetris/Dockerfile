FROM oven/bun:1.3.14-alpine AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY examples/tetris ./examples/tetris
RUN bun build examples/tetris/render.tsx \
	--target=browser \
	--minify \
	--outfile=examples/tetris/app.js

FROM oven/bun:1.3.14-alpine

WORKDIR /app
COPY --from=build /app/src ./src
COPY --from=build /app/examples/tetris ./examples/tetris

ENV NODE_ENV=production \
	PORT=8080 \
	TETRIS_DB_PATH=/app/examples/tetris/tetris.db

EXPOSE 8080
WORKDIR /app/examples/tetris
CMD ["bun", "server.tsx"]
