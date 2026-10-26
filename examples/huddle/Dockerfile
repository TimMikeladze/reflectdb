FROM oven/bun:1.4.4-alpine AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY examples/huddle ./examples/huddle
RUN bun build examples/huddle/app.tsx \
	--target=browser \
	--minify \
	--outfile=examples/huddle/app.js

FROM oven/bun:1.4.4-alpine

WORKDIR /app
COPY --from=build /app/src ./src
COPY --from=build /app/examples/huddle ./examples/huddle

ENV NODE_ENV=production \
	PORT=8080

EXPOSE 8080
WORKDIR /app/examples/huddle
CMD ["bun", "server.ts"]
