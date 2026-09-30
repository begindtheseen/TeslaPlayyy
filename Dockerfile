FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Deno is yt-dlp's JavaScript runtime for YouTube's player challenges (needed by the web_* clients).
FROM denoland/deno:bin AS deno

FROM node:22-bookworm-slim
WORKDIR /app

# ffmpeg: server-side remux (/api/muxed). yt-dlp from pip in a venv so it can be upgraded in place:
# YouTube changes break old yt-dlp releases within weeks, so rebuild often or set YTDLP_UPDATE_ON_START=1.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir -U "yt-dlp[default]" \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && yt-dlp --version && ffmpeg -version | head -1 \
    && chown -R node:node /opt/yt-dlp
COPY --from=deno /deno /usr/local/bin/deno

COPY --from=build --chown=node:node /app ./
COPY --chown=node:node scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
USER node
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "start"]
