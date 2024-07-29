FROM node
WORKDIR /backend
COPY package.json .
COPY package-lock.json .
COPY index.js .
COPY socket.js .
COPY logging /backend/logging
COPY /ssl /backend/ssl
RUN npm install
CMD [ "node", "index.js" ]