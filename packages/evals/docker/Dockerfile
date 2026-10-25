FROM node:24-slim AS builder
WORKDIR /work
# Copy the mounted source into a disposable build directory so atomic directory
# renames work on one filesystem. Only outputs under /opt/evaluator persist.
RUN --mount=type=bind,source=.,target=/source \
    --mount=type=cache,target=/root/.npm \
    mkdir /repo \
    && cp -a /source/. /repo/ \
    && cd /repo \
    && npm ci --ignore-scripts \
    && npm run hydrate:model-data \
    && npm run build:offline \
    && node packages/evals/docker/install-runtime.mjs /opt/evaluator \
    && rm -rf /repo

# Both variants use the same installed runtime. The control removes only the
# coding-agent documentation whose effect the experiment measures.
FROM builder AS without-docs-install
RUN rm -rf \
    /opt/evaluator/install/node_modules/@earendil-works/pi-coding-agent/README.md \
    /opt/evaluator/install/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md \
    /opt/evaluator/install/node_modules/@earendil-works/pi-coding-agent/docs \
    /opt/evaluator/install/node_modules/@earendil-works/pi-coding-agent/examples

FROM node:24-slim AS evaluator
COPY --from=builder /opt/evaluator/root /repo
WORKDIR /repo/packages/evals
# Vitest starts as root so it can load evaluator code. Before prompting the
# model, the harness permanently drops to UID 65532. Keep evaluator sources
# root-only so model tools and generated code cannot inspect judges or fixtures.
RUN chmod -R go-rwx \
      /repo/packages/evals/src \
      /repo/packages/evals/evals \
      /repo/packages/evals/docker \
    && chmod go-rwx \
      /repo/vitest.base.ts \
      /repo/packages/evals/vitest.evals.config.ts \
    && mkdir -p /run/pi-eval-secrets \
    && chmod 0700 /run/pi-eval-secrets
ENTRYPOINT ["node", "--experimental-strip-types", "docker/entrypoint.ts"]

FROM evaluator AS without_docs
COPY --from=without-docs-install /opt/evaluator/install/node_modules /repo/node_modules
ENV PI_EVAL_VARIANT=without_docs

FROM evaluator AS with_docs
COPY --from=builder /opt/evaluator/install/node_modules /repo/node_modules
ENV PI_EVAL_VARIANT=with_docs
