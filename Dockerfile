FROM oven/bun:1

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs npm python3 make g++ ca-certificates \
  && npm install -g node-gyp \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile

COPY . .

ENV CYRENE_ROOT=/workspace
ENV CYRENE_ANIMATE_STREAMING=0
ENV PYTHON=/usr/bin/python3

CMD ["bun", "run", "start"]
