FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/portal.db COOKIE_SECURE=1
VOLUME /data
EXPOSE 3000
CMD ["npm","start"]
