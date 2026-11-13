# Imagen mínima. Node 24 trae SQLite integrado (node:sqlite): nada que compilar.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
