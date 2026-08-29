FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV DATA_DIR=/app/data
ENV PORT=3000
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "server.js"]
