# Reference implementation of transactional-email/v1.
#
# Pinned to an exact Bun version so a rebuild months from now produces the same
# image. This service is the worked example vendors copy; reproducibility is the
# whole point of the project, so it starts here.
FROM oven/bun:1.3.13-alpine

WORKDIR /app

# Dependencies first so a source change does not invalidate the install layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Only what the service needs at runtime. The suite, fixtures, site and MCP
# server are not deployed: this container is a vendor, not SOFtruth.
COPY reference-impl/ ./reference-impl/

ENV PORT=8787
EXPOSE 8787

# No shell wrapper, so signals reach the process and the platform can stop it cleanly.
CMD ["bun", "run", "reference-impl/server.ts"]
