# Tarang — Bun server + yt-dlp resolver fallback.
FROM oven/bun:1

USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages -U yt-dlp

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public
COPY launch ./launch

ENV PORT=8080
ENV YT_DLP_PATH=/usr/local/bin/yt-dlp

USER bun
EXPOSE 8080

CMD ["bun", "server/index.ts"]
