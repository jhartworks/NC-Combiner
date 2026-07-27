# syntax=docker/dockerfile:1.7
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_FETCH_RETRIES=0 \
    NPM_CONFIG_FETCH_TIMEOUT=30000
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY dist ./dist
EXPOSE 8023
CMD ["node", "server/index.js"]
