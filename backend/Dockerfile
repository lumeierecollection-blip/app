# Amendment F backend -- plain Node.js, in-memory state, one dependency
# (firebase-admin, for optional push). No native modules, so any base works;
# node:20-slim matches tradeapp's deploy path.

FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lib ./lib
COPY server.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
