const uWS = require('uWebSockets.js');
const path = require('path');
const AsyncLock = require('async-lock');
const handleLog = require('./logging/logger');
const lock = new AsyncLock();
require('dotenv').config()
const { RateLimiterMemory } = require("rate-limiter-flexible");

// Maps to store necessary data
const doubleChatRoomWaitingPeople = [];
const doubleVideoRoomWaitingPeople = [];
const doubleChatRooms = new Map();
const doubleVideoRooms = new Map();
const personChoice = new Map();
const socketToRoom = new Map();
const connectionsPerIp = new Map();

// Number of active connections
var connections = 0;

// Port to listen
const port = 443;

// Certificate Path SSL/TLS certificate files
const keyFilePath = path.join(__dirname, 'ssl', 'private.key');
const certFilePath = path.join(__dirname, 'ssl', 'certificate.crt');

// Options for rate limiter
const opts = {
  points: 50, // starting points
  duration: 1, // Per second
  blockDuration: 3, // block for 3 seconds if more than points consumed
};

const rateLimiter = new RateLimiterMemory(opts);

uWS.SSLApp({
  key_file_name: keyFilePath,
  cert_file_name: certFilePath,
}).ws('/', {
  compression: uWS.SHARED_COMPRESSOR,
  maxPayloadLength: 1048576,
  maxLifetime: 0,
  idleTimeout: 0,

  upgrade: (res, req, context) => {
    const decoder = new TextDecoder('utf-8');
    const address = decoder.decode(res.getRemoteAddressAsText());

    // Check if the IP has more than 3 connections
    const ipCount = connectionsPerIp.get(address) || 0;
    if (ipCount >= 3) {
      res.writeStatus('403 Forbidden').end('Connection limit exceeded');
      return;
    } else {
      connectionsPerIp.set(address, ipCount + 1);
    }

    const roomType = req.getQuery("RT");
    if (roomType !== "chat" && roomType !== "video") {
      res.writeStatus('403 Forbidden').end('Connection rejected');
      return;
    }

    res.upgrade(
      { ip: address, roomType, id: req.getHeader('sec-websocket-key') },
      req.getHeader('sec-websocket-key'),
      req.getHeader('sec-websocket-protocol'),
      req.getHeader('sec-websocket-extensions'),
      context
    );
  },

  open: (ws) => {
    console.log("WebSocket connected : " + ws.id);
    reconnect(ws, ws.roomType, true);
  },

  message: (ws, message, isBinary) => {
    rateLimiter.consume(ws.id, 2).then((rateLimiterRes) => {
      const room = socketToRoom.get(ws.id);
      if (room) ws.publish(room, message);
    }).catch((rateLimiterRes) => {
      console.log("Rate limit exceeded for " + ws.id);
    });
  },

  drain: (ws) => {
    console.log('WebSocket backpressure : ' + ws.getBufferedAmount());
  },

  close: (ws, code, message) => {
    console.log("WebSocket disconnected : " + ws.id);

    // Decrease the connection count for IP
    const ip = ws.ip;
    const currentCount = connectionsPerIp.get(ip);
    if (currentCount > 1) {
      connectionsPerIp.set(ip, currentCount - 1);
    } else {
      connectionsPerIp.delete(ip);
    }

    handleDisconnect(ws);
  }
}).get('/connections', (res, req) => {
  // Get the origin of the request
  const origin = req.getHeader('origin');

  // Set CORS headers conditionally
  if (origin === 'http://localhost:3000' || origin === 'https://picolon.com') {
    res.writeHeader('Access-Control-Allow-Origin', origin);
  }

  res.writeHeader('Access-Control-Allow-Methods', 'GET');
  res.writeHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(connections.toString());
}).listen(port, (token) => {
  handleLog(token ? `Listening to port ${port}` : `Failed to listen to port ${port}`);
});

const reconnect = async (ws, roomType, isConnected = false) => {
  try {
    lock.acquire("reconnect", async (done) => {
      console.log("reconnect lock acquired for " + ws.id);

      if (isConnected) {
        connections++;
      }

      personChoice.set(ws.id, roomType);
      const waitingPeople = roomType === "chat" ? doubleChatRoomWaitingPeople : doubleVideoRoomWaitingPeople;
      const peerSocket = waitingPeople.length > 0 ? waitingPeople.splice(Math.floor(Math.random() * waitingPeople.length), 1)[0] : null;

      if (peerSocket) {
        const room = `${peerSocket.id}#${ws.id}`;
        peerSocket.subscribe(room);
        ws.subscribe(room);

        const rooms = roomType === "chat" ? doubleChatRooms : doubleVideoRooms;
        rooms.set(room, { socket1: ws, socket2: peerSocket });
        socketToRoom.set(ws.id, room);
        socketToRoom.set(peerSocket.id, room);

        const message = JSON.stringify({ type: 'paired', message: "You are connected to Stranger" });
        ws.send(message);
        peerSocket.send(message);

        if (roomType === "video") {
          ws.send(JSON.stringify({ type: 'initiator', message: "You are the initiator!" }));
        }

        done();
      } else {
        waitingPeople.push(ws);
      }

      done();
    }, function (err, ret) {
      console.log("reconnect lock released for " + ws.id);
    }, {});
  } catch (error) {
    handleLog(`Error in reconnect: ${error.message}`);
  }
}

const handleDisconnect = async (ws) => {
  try {
    lock.acquire("disconnect", async (done) => {
      console.log("disconnect lock acquired for " + ws.id);
      console.log("Connections Remaining: " + --connections);

      const room = socketToRoom.get(ws.id);
      const roomType = personChoice.get(ws.id);
      personChoice.delete(ws.id);

      if (room) {
        const rooms = roomType === "chat" ? doubleChatRooms : doubleVideoRooms;
        const { socket1, socket2 } = rooms.get(room);
        const remainingSocket = (socket1.id === ws.id) ? socket2 : socket1;

        remainingSocket.send(JSON.stringify({ type: 'peer_disconnected', message: "Your peer is disconnected" }));
        rooms.delete(room);
        socketToRoom.delete(ws.id);
        socketToRoom.delete(remainingSocket.id);

        done();
        reconnect(remainingSocket, roomType);
      } else {
        const waitingPeople = roomType === "chat" ? doubleChatRoomWaitingPeople : doubleVideoRoomWaitingPeople;
        const index = waitingPeople.indexOf(ws);
        if (index !== -1) waitingPeople.splice(index, 1);
      }

      done();
    }, function (err, ret) {
      console.log("disconnect lock released for " + ws.id);
    }, {});
  } catch (error) {
    handleLog(`Error in disconnect: ${error.message}`);
  }
}
