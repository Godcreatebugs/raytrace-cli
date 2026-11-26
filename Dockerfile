# Stdio MCP server for Glama and other clients.
# Build this image, then speak newline-delimited JSON-RPC on stdin/stdout.
# initialize and tools/list need no API key, config file, account, or VM.
#
# The CLI is plain ESM (bin/ and src/). There is no compile step. Runtime
# packages are whatever package.json lists under dependencies; today that
# set is empty, and the dashboard toolchain stays out of the image.

FROM node:22-bookworm-slim

# engines.node is ^22.16.0 || >=24 (node:sqlite FTS5). Refuse an older 22 tag.
RUN node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 16) || major === 23) { console.error("RayTrace needs Node.js 22.16+ or 24+, got " + process.version); process.exit(1); }'

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && rm -rf /root/.npm

COPY bin ./bin
COPY src ./src
COPY proxy ./proxy
COPY worker ./worker

# mcp already skips the npm update check. This keeps a container scan from
# phoning the registry if that path changes, and gives the node user a
# writable home for ~/.raytrace if a later tool call needs it.
ENV NODE_ENV=production \
    RAYTRACE_NO_UPDATE_CHECK=1 \
    HOME=/home/node

USER node

# Exec form, no shell: stdin and stdout stay the MCP stream.
ENTRYPOINT ["node", "bin/raytrace.mjs", "mcp"]
