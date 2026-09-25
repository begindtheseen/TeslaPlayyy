FROM node:18-bookworm

WORKDIR /app
COPY package.json package-lock.json ./

# Install Python + build tools for npm
RUN apt-get update && \
    apt-get install -y python3 build-essential && \
    rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:18-bookworm
WORKDIR /app

# Install runtime dependencies
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

COPY --from=0 /app/node_modules ./node_modules
COPY --from=0 /app/.next ./.next
COPY --from=0 /app/public ./public
COPY --from=0 /app/lib ./lib
COPY --from=0 /app/pages ./pages
COPY package.json ./

EXPOSE 3000
CMD ["npm", "start"]
