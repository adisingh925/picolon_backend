const uWS = require('uWebSockets.js');
const path = require('path');
const AsyncLock = require('async-lock');
const handleLog = require('./logging/logger');
const lock = new AsyncLock();
require('dotenv').config()

// Maps to store necessary data
const doubleChatRoomWaitingPeople = [];
const doubleVideoRoomWaitingPeople = [];
const doubleChatRooms = new Map();
const doubleVideoRooms = new Map();
const personChoice = new Map();
const socketToRoom = new Map();

// Number of active connections
var connections = 0;

// Port to listen
const port = 80;

// Certificate Path SSL/TLS certificate files
const keyFilePath = path.join(__dirname, 'ssl', 'private.key');
const certFilePath = path.join(__dirname, 'ssl', 'certificate.crt');
const caFilePath = path.join(__dirname, 'ssl', 'ca_bundle.crt');

const app = uWS.App({
  key_file_name: keyFilePath,
  cert_file_name: certFilePath,
  ca_file_name: caFilePath,
}).ws('/', {
  compression: uWS.SHARED_COMPRESSOR,
  maxPayloadLength: 1048576,
  maxLifetime: 0,
  idleTimeout: 0,

  upgrade: (res, req, context) => {
    const roomType = req.getQuery("RT");
    if (roomType !== "chat" && roomType !== "video") {
      res.writeStatus('403 Forbidden').end('Connection rejected');
      return;
    }

    res.upgrade(
      { ip: res.getRemoteAddressAsText(), roomType, id: req.getHeader('sec-websocket-key') },
      req.getHeader('sec-websocket-key'),
      req.getHeader('sec-websocket-protocol'),
      req.getHeader('sec-websocket-extensions'),
      context
    );
  },

  open: (ws) => {
    console.log("WebSocket connected : " + ws.id);
    reconnect(ws, ws.roomType);
  },

  message: (ws, message, isBinary) => {
    const room = socketToRoom.get(ws.id);
    if (room) ws.publish(room, message);
  },

  drain: (ws) => {
    console.log('WebSocket backpressure : ' + ws.getBufferedAmount());
  },

  close: (ws, code, message) => {
    console.log("WebSocket disconnected : " + ws.id);
    handleDisconnect(ws);
  }
}).get('/connections', (res) => {
  res.end(connections.toString());
}).listen(port, (token) => {
  handleLog(token ? `Listening to port ${port}` : `Failed to listen to port ${port}`);
});

const reconnect = async (ws, roomType) => {
  try {
    lock.acquire("reconnect", async (done) => {
      console.log("reconnect lock acquired for " + ws.id);
      ++connections;

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
      handleLog("reconnect lock released for " + ws.id);
    }, {});
  } catch (error) {
    handleLog(`Error in reconnect: ${error.message}`);
  }
}

const handleDisconnect = async (ws) => {
  try {
    lock.acquire("disconnect", async (done) => {
      console.log("disconnect lock acquired for " + ws.id);
      --connections;

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
      handleLog("disconnect lock released for " + ws.id);
    }, {});
  } catch (error) {
    handleLog(`Error in disconnect: ${error.message}`);
  }
}
