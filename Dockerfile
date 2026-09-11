# The remote MCP endpoint, and nothing else.
#
# Only mcp/ and the type definitions it reads are copied in. The agent, the
# browser, and the mailbox never run here: this process serves the published
# register and holds no credentials, so there is nothing in it worth stealing
# and no key that could leak from a public unauthenticated endpoint.
#
# Bun is pinned to the version CI tests against. A runtime that drifts from the
# one the tests ran on is a difference nobody would notice until it mattered.

FROM oven/bun:1.3.13-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY mcp ./mcp
COPY agent/types.ts ./agent/types.ts

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "run", "mcp/http.ts"]
