FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY scripts ./scripts
RUN mkdir -p /data
ENV DB_PATH=/data/paper.db
EXPOSE 18080
CMD ["npm", "start"]
