# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci

COPY src ./src

RUN npm run build

# Production stage
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY --from=builder /app/build ./build

# Variáveis de ambiente padrão (podem ser sobrescritas no docker-compose)
ENV WEBHOOK_PORT=3000
ENV WEBHOOK_URL_BASE=http://localhost:3000

EXPOSE 3000

# O comando padrão inicia o servidor
CMD ["node", "build/index.js"]