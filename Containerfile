FROM node:lts AS builder

WORKDIR /usr/src/app

RUN npx playwright install --with-deps

COPY package*.json tsconfig.json ./

RUN npm install --omit=optional

COPY . .

RUN npm run build

CMD ["node", "dist/monitor.js"]