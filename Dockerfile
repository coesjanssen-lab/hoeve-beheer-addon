FROM ghcr.io/home-assistant/base:latest
RUN apk add --no-cache nodejs tar
COPY server.js /app/server.js
COPY index.html /app/www/index.html
WORKDIR /app
CMD ["node", "/app/server.js"]
