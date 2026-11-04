FROM node:lts-alpine
RUN apk add --no-cache watchexec
WORKDIR /app
CMD [ "npm", "run", "build"]
