FROM node:24-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/app/data
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
CMD ["node", "src/main.js"]
