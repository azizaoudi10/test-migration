FROM node:22-slim AS base

ENV PNPM_VERSION=10.34.5 \
    NODE_ENV=production \
    PNPM_HOME=/pnpm

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    tar \
    ripgrep \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
    build-essential \
    libx11-dev \
    libxkbfile-dev \
    libsecret-1-dev \
    libgtk-3-dev \
    libnss3 \
    libxss1 \
    libasound2-dev \
    libatk-bridge2.0-0 \
    libpango1.0-0 \
    libcairo2 \
    libgbm1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxfixes3 \
    libdbus-1-3 \
    libx11-xcb1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

FROM base AS desktop-build

COPY apps/desktop/package.json apps/desktop/tsconfig.json ./
COPY apps/desktop/vite.config.ts apps/desktop/electron-builder.yml ./
COPY apps/desktop/scripts ./scripts
COPY apps/desktop/src ./src
COPY apps/desktop/electron ./electron
COPY apps/desktop/build ./build
COPY apps/desktop/dist-electron ./dist-electron
COPY apps/desktop/dist-renderer ./dist-renderer
COPY tsconfig.base.json ./tsconfig.base.json

RUN pnpm --filter @fraktole/desktop install --frozen-lockfile && \
    pnpm --filter @fraktole/desktop build

FROM base AS runtime

ENV PNPM_NO_FROZEN_INSTALL=false

COPY --from=desktop-build /workspace /workspace
COPY apps/desktop/package.json /workspace/apps/desktop/package.json

RUN pnpm --filter @fraktole/desktop prune --prod && \
    pnpm --filter @fraktole/desktop rebuild

WORKDIR /workspace/apps/desktop
ENTRYPOINT ["pnpm", "start"]
