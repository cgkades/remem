# Runs tests/pi.e2e.mjs in a Linux container against a real `pi` CLI binary
# and a local deterministic mock model server -- no real API credentials are
# used or required, and the container's isolated filesystem means the test's
# HOME override (already used for host runs too) has nothing real to touch.
# Build natively for your host architecture: docker build -f docker/pi-e2e.Dockerfile -t remem-pi-e2e .
FROM node:22-bookworm-slim

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Pin the same major version documented in package.json's optional peer
# dependency / devDependency entries for @earendil-works/pi-coding-agent.
RUN npm install -g @earendil-works/pi-coding-agent@0.85.0

CMD ["npm", "run", "test:pi:e2e"]
