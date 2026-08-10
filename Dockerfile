# syntax=docker/dockerfile:1

# Two stages so the npm cache and the build-time copies of package metadata
# never reach the running image. The app has no compile step -- the only thing
# "built" here is the pdf.js asset tree.
#
# WHY -slim AND NOT -alpine: the plan called for node:22-alpine, and the app
# itself is pure JavaScript -- but @fastify/secure-session depends on
# sodium-native, which is a native addon distributed as prebuilt binaries, and
# sodium-native 5.x publishes no linux-x64-musl build. On Alpine the container
# dies at boot with "Cannot find addon" from require-addon. The options were a
# glibc shim (apk add gcompat plus a hand-faked prebuilds/linux-x64-musl
# directory) or a glibc base image; shimming the library that encrypts the
# session cookie is not a thing to be clever about. bookworm-slim is ~60 MB
# larger and entirely unremarkable. Revisit if sodium-native ships musl
# prebuilds.

# --- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Manifests first: these layers only re-run when dependencies actually change.
COPY package.json package-lock.json ./

# scripts/ comes before the install because package.json's `prepare` hook runs
# scripts/copy-pdfjs.js. npm's documentation says `prepare` is skipped under
# --omit=dev, but npm 10 runs it anyway -- and a build that fails depending on
# which npm the base image ships is not worth the saved layer.
COPY scripts/ ./scripts/

# Runtime dependencies only. `npm ci` insists on a lockfile, which is exactly
# what makes the image reproducible.
#
# Then produce public/pdfjs/ explicitly, because the other half of that npm
# behaviour -- `prepare` being skipped -- would leave the image with a PDF
# viewer and none of its assets. pdfjs-dist is a *production* dependency, so it
# is installed either way, and the copy script wipes and rebuilds its output
# directory, so running it twice is harmless.
RUN npm ci --omit=dev && node scripts/copy-pdfjs.js

# --- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
# Everything the app writes lives under one directory, so there is exactly one
# volume to mount (see docker-compose.yml).
ENV DATA_DIR=/app/data

WORKDIR /app

# Application code. Ordered least- to most-frequently changed.
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY scripts/ ./scripts/
COPY public/ ./public/
COPY src/ ./src/

# After public/, so the freshly built asset tree is what lands in the image.
COPY --from=build /app/public/pdfjs ./public/pdfjs

# The app runs unprivileged. The official node images already ship a `node`
# user (uid 1000); DATA_DIR is the only path it needs to write, so it is the
# only path we hand over. Bind-mounting a host ./data over this works as long
# as the host directory is owned by uid 1000 -- deploy.sh creates it for that
# reason.
RUN mkdir -p "$DATA_DIR/preview-cache" && chown -R node:node "$DATA_DIR"

# No VOLUME instruction on purpose: it would make a plain `docker run` create a
# throwaway anonymous volume, quietly losing the preview cache and state.json
# on every re-run. Compose mounts ./data here explicitly instead.

USER node

EXPOSE 3000

# The slim image has no curl, and adding one just for a health check is a
# package we would then have to keep patched. Node 22 has a global fetch, so
# the runtime we already trust can check itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Exec form, so node is PID 1 and receives SIGTERM directly -- src/index.js
# installs a handler that closes the server cleanly.
CMD ["node", "src/index.js"]
