FROM node:20-alpine

WORKDIR /app

COPY package.json ./
# Unlike tradeapp's Dockerfile (which skips this because firebase-admin is
# lazily dynamic-imported and optional -- push works or doesn't depending on
# whether it happens to be present), @supabase/supabase-js is this app's
# primary datastore client, loaded unconditionally on every request. It has
# to actually be installed.
RUN npm install --omit=dev
COPY lib ./lib
COPY server.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
