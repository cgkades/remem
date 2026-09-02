# Runs tests/opencode-v2.e2e.mjs in a Linux container so it exercises the same
# @opencode-ai/cli-linux-arm64 / -x64 binaries CI does, regardless of host OS.
# Build natively for your host architecture (arm64 on Apple Silicon, no emulation
# needed): docker build --platform linux/arm64 -f docker/opencode-v2-e2e.Dockerfile -t remem-opencode-v2-e2e .
FROM node:22-bookworm-slim

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["npm", "run", "test:opencode-v2"]
