# Node 24.7.0 bookworm-slim, verified from the upstream OCI index.
FROM docker.io/library/node@sha256:0104d9447ea3ddf7373643be7f9915fc7b7c896e41d0d33229338e457217cd78
WORKDIR /app
COPY services/common.mjs services/common.mjs
COPY services/faults.mjs services/faults.mjs
COPY services/web/ services/web/
ARG SOURCE_REVISION
RUN test -n "$SOURCE_REVISION"
ENV SOURCE_REVISION=$SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "services/web/main.mjs"]
