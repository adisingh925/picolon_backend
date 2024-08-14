const uWS = require('uWebSockets.js');
const path = require('path');
const AsyncLock = require('async-lock');
const handleLog = require('./logging/logger');
const lock = new AsyncLock();
require('dotenv').config()
const { RateLimiterMemory } = require("rate-limiter-flexible");
const { v4: uuidv4 } = require('uuid');

//constants
const PRIVATE_TEXT_CHAT_DUO = '0';
const PRIVATE_VIDEO_CHAT_DUO = '1';
const PUBLIC_TEXT_CHAT_MULTI = '2';

//server broadcast messages
const CONNECTION_LIMIT_EXCEEDED = 'connection_limit_exceeded';
const RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded';
const CONNECTION_REJECTED = 'connection_rejected';
const STRANGER_DISCONNECTED_FROM_THE_ROOM = 'stranger_disconnected_from_the_room';
const YOU_ARE_CONNECTED_TO_THE_ROOM = 'you_are_connected_to_the_room';
const STRANGER_CONNECTED_TO_THE_ROOM = 'stranger_connected_to_the_room';
const ROOM_NOT_FOUND = 'room_not_found';

// Maps to store necessary data
const doubleChatRoomWaitingPeople = [];
const doubleVideoRoomWaitingPeople = [];
const textChatDuoRoomIdToSockets = new Map();
const videoChatDuoRoomIdToSockets = new Map();
const socketIdToRoomType = new Map();
const socketIdToRoomId = new Map();
const connectionsPerIp = new Map();
const textChatMultiRoomIdToSockets = new Map();
const roomIdToRoomData = new Map();

// Number of active connections
var connections = 0;

// Port to listen
const port = 443;

// Certificate Path SSL/TLS certificate files
const keyFilePath = path.join(__dirname, 'ssl', 'private.key');
const certFilePath = path.join(__dirname, 'ssl', 'certificate.crt');

// Options for rate limiter
const opts = {
  points: 50,
  duration: 1,
  blockDuration: 3,
};

const rateLimiter = new RateLimiterMemory(opts);

// Allowed roomId types
const allowedRoomTypes = [PRIVATE_TEXT_CHAT_DUO, PRIVATE_VIDEO_CHAT_DUO, PUBLIC_TEXT_CHAT_MULTI];

uWS.SSLApp({
  key_file_name: keyFilePath,
  cert_file_name: certFilePath,
}).ws('/', {
  compression: uWS.SHARED_COMPRESSOR,
  maxPayloadLength: 1048576,
  maxLifetime: 0,
  idleTimeout: 0,

  upgrade: (res, req, context) => {
    const address = convertArrayBufferToString(res.getRemoteAddressAsText());

    // Check if the IP has more than 3 connections
    const ipCount = connectionsPerIp.get(address) || 0;
    if (ipCount >= 3) {
      res.writeStatus('403 Forbidden').end(CONNECTION_LIMIT_EXCEEDED);
      return;
    } else {
      connectionsPerIp.set(address, ipCount + 1);
    }

    // Sanitize and validate roomType
    const roomType = req.getQuery("RT");
    if (!allowedRoomTypes.includes(roomType)) {
      res.writeStatus('403 Forbidden').end(CONNECTION_REJECTED);
      return;
    }

    // Sanitize and validate roomName
    const roomName = req.getQuery("RN");
    if (roomName && typeof roomName !== 'string') {
      res.writeStatus('403 Forbidden').end(CONNECTION_REJECTED);
      return;
    }

    // Sanitize and validate roomId
    const roomId = req.getQuery("RID");
    if (roomId && typeof roomId !== 'string') {
      res.writeStatus('403 Forbidden').end(CONNECTION_REJECTED);
      return;
    }

    // Upgrade WebSocket connection
    res.upgrade(
      { ip: address, roomType, roomName, roomId, id: req.getHeader('sec-websocket-key') },
      req.getHeader('sec-websocket-key'),
      req.getHeader('sec-websocket-protocol'),
      req.getHeader('sec-websocket-extensions'),
      context
    );
  },

  subscription: (ws, roomId) => {
    console.log(`WebSocket (${ws.id}) subscribed to roomId : ` + convertArrayBufferToString(roomId));
  },

  open: (ws) => {
    console.log("WebSocket connected : " + ws.id);
    reconnect(ws, true);
  },

  message: (ws, message, isBinary) => {
    rateLimiter.consume(ws.id, 1).then((rateLimiterRes) => {
      const roomId = socketIdToRoomId.get(ws.id);
      if (roomId) ws.publish(roomId, message);
    }).catch((rateLimiterRes) => {
      console.log("Rate limit exceeded for " + ws.id);
      ws.send(JSON.stringify({ type: RATE_LIMIT_EXCEEDED }));
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
}).get('/api/v1/connections', (res, req) => {
  // Get the origin of the request
  const origin = req.getHeader('origin');

  // Set CORS headers conditionally
  if (origin === 'http://localhost:3000' || origin === 'https://picolon.com') {
    res.writeHeader('Access-Control-Allow-Origin', origin);
  }

  res.writeHeader('Access-Control-Allow-Methods', 'GET');
  res.writeHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(connections.toString());
}).get("/api/v1/public-text-chat-rooms", (res, req) => {
  // Get the origin of the request
  const origin = req.getHeader('origin');

  // Set CORS headers conditionally
  if (origin === 'http://localhost:3000' || origin === 'https://picolon.com') {
    res.writeHeader('Access-Control-Allow-Origin', origin);
  }

  const rooms = Array.from(roomIdToRoomData.values());
  res.end(JSON.stringify(rooms));
}).listen(port, (token) => {
  handleLog(token ? `Listening to port ${port}` : `Failed to listen to port ${port}`);
});

const reconnect = async (ws, isConnected = false) => {
  try {
    lock.acquire("reconnect", async (done) => {
      console.log("reconnect lock acquired for " + ws.id);

      if (isConnected) {
        connections++;
      }

      const roomType = ws.roomType;
      socketIdToRoomType.set(ws.id, roomType);

      if (roomType === PUBLIC_TEXT_CHAT_MULTI) {

        // Check if the person is already in a roomId
        const roomId = socketIdToRoomId.get(ws.id);

        if (roomId) {
          // Unsubscribe from the current roomId if present
          ws.unsubscribe(roomId);

          // send message to roomId that the peer is disconnected
          ws.publish(roomId, JSON.stringify({ type: STRANGER_DISCONNECTED_FROM_THE_ROOM }));

          // Remove the user from the chat roomId map if present
          const socketsInRoom = textChatMultiRoomIdToSockets.get(roomId);

          if (socketsInRoom) {
            if (socketsInRoom.has(ws)) {
              socketsInRoom.delete(ws);

              // If the roomId is empty, delete the roomId else update the roomId
              if (socketsInRoom.size === 0) {
                textChatMultiRoomIdToSockets.delete(roomId);
                roomIdToRoomData.delete(roomId);
              } else {
                textChatMultiRoomIdToSockets.set(roomId, socketsInRoom);
              }
            }
          }
        }

        if (ws.roomName) {
          const roomId = uuidv4();

          // Subscribe to the new roomId
          ws.subscribe(roomId);

          socketIdToRoomId.set(ws.id, roomId);
          textChatMultiRoomIdToSockets.set(roomId, new Set([ws]));
          roomIdToRoomData.set(roomId, { roomName: ws.roomName, createTime: new Date().getTime(), roomId, connections: 1 });
        } else if (ws.roomId) {
          const socketsInRoom = textChatMultiRoomIdToSockets.get(ws.roomId);

          if (socketsInRoom) {
            socketsInRoom.add(ws);

            // Subscribe to the roomId
            ws.subscribe(ws.roomId);

            // Increase the connection count for the roomId
            const roomData = roomIdToRoomData.get(ws.roomId);
            roomData.connections++;

            // Send message to the current user that he is connected to the roomId
            ws.send(JSON.stringify({ type: YOU_ARE_CONNECTED_TO_THE_ROOM, roomId: ws.roomId, roomData }));

            // Send message to all the people in the roomId except the current user
            ws.publish(ws.roomId, JSON.stringify({
              type: STRANGER_CONNECTED_TO_THE_ROOM,
            }), false /* isBinary */, true /* excludeSelf */);

            socketIdToRoomId.set(ws.id, ws.roomId);
            textChatMultiRoomIdToSockets.set(ws.roomId, socketsInRoom);
          } else {
            ws.send(JSON.stringify({ type: ROOM_NOT_FOUND }));
            ws.close();
          }
        }
      } else {
        const waitingPeople = roomType === PRIVATE_TEXT_CHAT_DUO ? doubleChatRoomWaitingPeople : doubleVideoRoomWaitingPeople;
        const peerSocket = waitingPeople.length > 0 ? waitingPeople.splice(Math.floor(Math.random() * waitingPeople.length), 1)[0] : null;

        if (peerSocket) {
          const roomId = uuidv4();
          peerSocket.subscribe(roomId);
          ws.subscribe(roomId);

          const rooms = roomType === PRIVATE_TEXT_CHAT_DUO ? textChatDuoRoomIdToSockets : videoChatDuoRoomIdToSockets;
          rooms.set(roomId, { socket1: ws, socket2: peerSocket });
          socketIdToRoomId.set(ws.id, roomId);
          socketIdToRoomId.set(peerSocket.id, roomId);

          const message = JSON.stringify({ type: 'paired', message: "You are connected to Stranger" });
          ws.send(message);
          peerSocket.send(message);

          if (roomType === PRIVATE_VIDEO_CHAT_DUO) {
            ws.send(JSON.stringify({ type: 'initiator', message: "You are the initiator!" }));
          }
        } else {
          waitingPeople.push(ws);
        }
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

      const roomId = socketIdToRoomId.get(ws.id);
      const roomType = socketIdToRoomType.get(ws.id);
      socketIdToRoomType.delete(ws.id);

      if (roomType === PUBLIC_TEXT_CHAT_MULTI) {
        if (roomId) {
          const socketsInRoom = textChatMultiRoomIdToSockets.get(roomId);

          if (socketsInRoom) {
            socketsInRoom.delete(ws);

            if (socketsInRoom.size === 0) {
              textChatMultiRoomIdToSockets.delete(roomId);
              roomIdToRoomData.delete(roomId);
            } else {
              // Decrease the connection count for the roomId
              roomData = roomIdToRoomData.get(roomId);
              roomData.connections--;
              roomIdToRoomData.set(roomId, roomData);

              textChatMultiRoomIdToSockets.set(roomId, socketsInRoom);
              socketsInRoom.forEach(socket => {
                socket.send(JSON.stringify({
                  type: STRANGER_DISCONNECTED_FROM_THE_ROOM,
                }));
              });
            }
          }

          socketIdToRoomId.delete(ws.id);
        }
      } else {
        if (roomId) {
          const rooms = roomType === PRIVATE_TEXT_CHAT_DUO ? textChatDuoRoomIdToSockets : videoChatDuoRoomIdToSockets;
          const { socket1, socket2 } = rooms.get(roomId);
          const remainingSocket = (socket1.id === ws.id) ? socket2 : socket1;

          remainingSocket.send(JSON.stringify({ type: 'peer_disconnected', message: "Your peer is disconnected" }));
          rooms.delete(roomId);
          socketIdToRoomId.delete(ws.id);
          socketIdToRoomId.delete(remainingSocket.id);

          done();
          reconnect(remainingSocket);
        } else {
          const waitingPeople = roomType === PRIVATE_TEXT_CHAT_DUO ? doubleChatRoomWaitingPeople : doubleVideoRoomWaitingPeople;
          const index = waitingPeople.indexOf(ws);
          if (index !== -1) waitingPeople.splice(index, 1);
        }
      }

      done();
    }, function (err, ret) {
      console.log("disconnect lock released for " + ws.id);
    }, {});
  } catch (error) {
    handleLog(`Error in disconnect: ${error.message}`);
  }
}

const convertArrayBufferToString = (arrayBuffer) => {
  const decoder = new TextDecoder();
  return decoder.decode(arrayBuffer);
}
