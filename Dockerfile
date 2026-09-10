# Runs the whole monitor -- Node server + headless Chromium holding the
# WhatsApp Web session -- as one always-on container.
FROM node:20-bookworm-slim

# Chromium and the fonts/libs it needs. whatsapp-web.js drives this via puppeteer.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation fonts-noto-color-emoji \
    ca-certificates \
    procps \
  && rm -rf /var/lib/apt/lists/*

# Fail the BUILD (not a mystery at runtime) if Chromium cannot execute here.
RUN chromium --version \
 && chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
      --dump-dom about:blank > /dev/null \
 && echo "chromium smoke test OK"

ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .

# The WhatsApp session, live message store, and C3 cache must survive restarts,
# so mount a persistent disk at /app/data and /app/.wwebjs_auth on the platform.
EXPOSE 4321
# Cap Node's heap so headless Chromium has memory left on a 512 MB box.
CMD ["node", "--max-old-space-size=256", "src/server.js"]
