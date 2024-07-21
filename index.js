const express = require("express");
const { createServer } = require("http");
const setupSocket = require("./socket");

const app = express();

const httpServer = createServer(app);
setupSocket(httpServer)

httpServer.listen(80, () => {
  console.log("Server is listening on port 80");
});
