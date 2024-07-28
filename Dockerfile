FROM node
WORKDIR /backend
COPY package.json .
COPY package-lock.json .
COPY index.js .
COPY socket.js .
COPY .env.vault .
COPY logging /backend/logging
COPY /ssl /backend/ssl
ENV DOTENV_KEY=dotenv://:key_d8c5c8f3435b18ca8600dfe7176c27b0aacb5759b79631b2daccc7a7030501a4@dotenv.org/vault/.env.vault?environment=production
RUN npm install
CMD [ "node", "index.js" ]