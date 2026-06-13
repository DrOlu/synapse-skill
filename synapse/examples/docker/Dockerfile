FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY agents/ ./agents/
COPY tsconfig.json ./

RUN npm run build || true

CMD ["node", "dist/bob-agent.js"]
