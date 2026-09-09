# Node 24.7.0 bookworm-slim, verified from the upstream OCI index.
FROM docker.io/library/node@sha256:0104d9447ea3ddf7373643be7f9915fc7b7c896e41d0d33229338e457217cd78
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY services/database.mjs services/database.mjs
COPY services/common.mjs services/common.mjs
COPY services/worker/ services/worker/
ARG SOURCE_REVISION
RUN test -n "$SOURCE_REVISION"
ENV SOURCE_REVISION=$SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8082
CMD ["node", "services/worker/main.mjs"]
