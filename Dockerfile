FROM node:20-slim

WORKDIR /app

# Install build tools for better-sqlite3 native module
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Ensure data directory exists for SQLite
RUN mkdir -p data

EXPOSE 3000

CMD ["node", "server/index.js"]
