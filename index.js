const express = require("express");
const https = require("https");
const setupSocket = require("./socket");
const fs = require("fs");

const app = express();

const httpsServer = https.createServer(
  {
    key: fs.readFileSync("ssl/private.key"),
    cert: fs.readFileSync("ssl/certificate.crt"),
    ca: fs.readFileSync("ssl/ca_bundle.crt"),
    requestCert: true,
    rejectUnauthorized: false,
  },
  app
);

setupSocket(httpsServer)

httpsServer.listen(443, () => {
  console.log("Server is listening on port 443");
});
