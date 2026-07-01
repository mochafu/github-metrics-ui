FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY public/ ./public/

ENV NODE_ENV=production

# Cloud Run injects PORT; server.mjs reads DASHBOARD_PORT, so forward it.
ENV DASHBOARD_PORT=${PORT:-8080}

EXPOSE 8080

CMD ["node", "src/server.mjs"]
