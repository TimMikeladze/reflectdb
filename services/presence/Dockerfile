FROM oven/bun:1.3.14-alpine AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY services ./services

FROM oven/bun:1.3.14-alpine

WORKDIR /app
# The service imports the Redis ephemeral adapter straight from src/, so the
# library source ships with it rather than being vendored or duplicated.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/services ./services

ENV NODE_ENV=production \
	PORT=8080

EXPOSE 8080
CMD ["bun", "services/presence/server.ts"]
