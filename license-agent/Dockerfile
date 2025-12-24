FROM node:20-alpine

# Install docker CLI
RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "licensev1.mjs"]
