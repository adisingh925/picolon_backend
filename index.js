const express = require("express");
const https = require("https");
const setupSocket = require("./socket");
const fs = require("fs");
const helmet = require("helmet");
const handleLog = require("./logging/logger");
require("dotenv").config();

const app = express();
app.use(helmet());
app.disable('x-powered-by');

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
  handleLog("Server is listening on port 443");
});
