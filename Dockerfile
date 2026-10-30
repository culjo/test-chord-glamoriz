# Glamoriz tool server. Built from the repo root because the server reads the catalogue and seed data from data/.
#   docker build --target test .   runs the test suite (used by the deploy workflow before building the app)
#   docker build .                 builds the app image (the last stage)
FROM node:22.20.0-alpine AS base
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./

FROM base AS test
RUN npm ci
COPY server/src ./src
COPY server/test ./test
COPY data /app/data
RUN npm test

FROM base AS app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
RUN npm ci --omit=dev && npm cache clean --force
COPY server/src ./src
COPY data /app/data

# The JSON store lives on a volume so orders survive restarts and redeploys.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

# Run node directly: config comes from the environment (docker compose's env_file), not a .env file in the image.
CMD ["node", "src/index.js"]
