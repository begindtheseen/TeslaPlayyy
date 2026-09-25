FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app

# ffmpeg + python3 for yt-dlp; curl to fetch the latest yt-dlp binary
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      ca-certificates \
      curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app ./

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
CMD ["npm", "start"]
