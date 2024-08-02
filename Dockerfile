FROM ubuntu
WORKDIR /backend
COPY package.json .
COPY package-lock.json .
COPY index.js .
COPY .env .
COPY logging /backend/logging
COPY /ssl /backend/ssl
RUN apt-get update && apt-get install -y nodejs npm
RUN npm install
CMD [ "node", "index.js" ]