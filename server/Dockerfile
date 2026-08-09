FROM node:20-bookworm-slim

# better-sqlite3 собирается нативно
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --omit=dev

WORKDIR /app
COPY . .

ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080

WORKDIR /app/server
CMD ["node", "src/index.js"]
