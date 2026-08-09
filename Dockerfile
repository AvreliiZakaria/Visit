# Сборка образа приложения.
# better-sqlite3 нативный, поэтому в сборочном слое нужны компиляторы,
# а в финальном образе их уже нет.

FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY assets ./assets
COPY docs ./docs
COPY index.html app.html login.html join.html admin.html .nojekyll ./

RUN mkdir -p /app/data /app/uploads && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
