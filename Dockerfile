# rlm-wiki container. Runs on Railway / Fly / anywhere Docker runs.
#
#   - Bun 1.3+ runtime for the web/API server
#   - git + CA certs for repository cloning
#   - JCODE for Agent mode
#   - vendored rlm-bun for legacy RLM mode
#
# Build:   docker build -t rlm-wiki .
# Run:     docker run --rm -p 3141:3141 -e GEMINI_API_KEY=... rlm-wiki

FROM oven/bun:1.3-slim AS runtime-deps

# System deps:
#  - git + ca-certificates: JCODE clones target repos
#  - ripgrep: fast RLM sandbox search; RLM still has a JS fallback if absent
#  - curl: install pinned JCODE release binary
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      ripgrep \
      curl \
 && rm -rf /var/lib/apt/lists/*

ENV JCODE_INSTALL_DIR=/usr/local/bin
ARG JCODE_VERSION=v0.11.15
ARG TARGETARCH
RUN set -eux; \
    build_arch="${TARGETARCH:-$(uname -m)}"; \
    case "$build_arch" in \
      amd64|x86_64) jcode_arch="x86_64" ;; \
      arm64|aarch64) jcode_arch="aarch64" ;; \
      *) echo "Unsupported build architecture: $build_arch" >&2; exit 1 ;; \
    esac; \
    tmpdir="$(mktemp -d)"; \
    trap 'rm -rf "$tmpdir"' EXIT; \
    curl -fsSL "https://github.com/1jehuang/jcode/releases/download/${JCODE_VERSION}/SHA256SUMS" -o "$tmpdir/SHA256SUMS"; \
    curl -fsSL "https://github.com/1jehuang/jcode/releases/download/${JCODE_VERSION}/jcode-linux-${jcode_arch}.tar.gz" -o "$tmpdir/jcode-linux-${jcode_arch}.tar.gz"; \
    (cd "$tmpdir" && grep "jcode-linux-${jcode_arch}.tar.gz" SHA256SUMS | sha256sum -c -); \
    tar -xzf "$tmpdir/jcode-linux-${jcode_arch}.tar.gz" -C "$tmpdir"; \
    install -m 0755 "$tmpdir/jcode-linux-${jcode_arch}" "$JCODE_INSTALL_DIR/jcode"; \
    install -m 0755 "$tmpdir/jcode-linux-${jcode_arch}.bin" "$JCODE_INSTALL_DIR/jcode-linux-${jcode_arch}.bin"; \
    find "$tmpdir" -maxdepth 1 -type f \( -name 'libssl.so*' -o -name 'libcrypto.so*' \) -exec cp -f {} "$JCODE_INSTALL_DIR/" \; ; \
    jcode --version

FROM runtime-deps AS deps

WORKDIR /app

# Node deps — copy lockfiles and local file dependencies first for layer caching.
COPY package.json bun.lock ./
COPY vendor/rlm-bun ./vendor/rlm-bun
COPY apps/desktop/package.json ./apps/desktop/package.json
RUN bun install --frozen-lockfile

FROM deps AS web-build

# Build the browser package inside Docker so production serves the Vite output,
# not the raw public HTML/CSS/JS sources.
COPY public ./public
COPY src/ui ./src/ui
COPY src/public-agent-prompt.ts ./src/public-agent-prompt.ts
COPY tsconfig.json ./tsconfig.json
COPY vite.web.config.ts ./vite.web.config.ts
RUN bun run build:web

FROM runtime-deps AS base

WORKDIR /app

# Runtime deps only. Dev tooling such as Vite is only needed in web-build.
COPY package.json bun.lock ./
COPY vendor/rlm-bun ./vendor/rlm-bun
COPY apps/desktop/package.json ./apps/desktop/package.json
RUN bun install --frozen-lockfile --production

# Application code — the part that changes most often, so last.
COPY bin ./bin
COPY src ./src
COPY --from=web-build /app/dist ./dist
COPY tsconfig.json ./tsconfig.json
COPY README.md ./README.md

# Runtime environment.
ENV NODE_ENV=production
ENV RLM_WIKI_SERVE_DIST=1
# Defaults — Railway overrides PORT at runtime.
ENV PORT=3141
ENV HOST=0.0.0.0
# Conservative concurrency for a 512 MB Hobby plan. Bump on Pro.
ENV RLM_WIKI_MAX_GENERATE=1
ENV RLM_WIKI_MAX_ASK=3

EXPOSE 3141

# rlm-wiki owns its own PORT handling (see bin/rlm-wiki.ts :: cmdServe).
CMD ["bun", "run", "./bin/rlm-wiki.ts", "serve"]
