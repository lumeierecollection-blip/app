# Amendment E backend -- plain Node.js + better-sqlite3, deployed to Render
# free tier (or any Docker host). glibc base (node:20-slim, NOT alpine) so
# better-sqlite3's prebuilt binaries work without a compiler.

FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Schema + all runtime code. server.js is the only entry point.
COPY lib ./lib
COPY sql ./sql
COPY server.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
