FROM node:lts AS app
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install -g
COPY . .
RUN npx playwright install --with-deps
RUN npm run build
CMD ["node", "dist/index.js"]