const uWS = require('uWebSockets.js');
const path = require('path');
const AsyncLock = require('async-lock');
const lock = new AsyncLock();
require('dotenv').config()
const { RateLimiterMemory } = require("rate-limiter-flexible");
const { v4: uuidv4 } = require('uuid');

const WEBSITE_URL = "https://picolon.com";
const allowedOrigins = [WEBSITE_URL];

//constants
const PRIVATE_TEXT_CHAT_DUO = '0';
const PRIVATE_VIDEO_CHAT_DUO = '1';
const PUBLIC_TEXT_CHAT_MULTI = '2';
const PRIVATE_TEXT_CHAT_MULTI = '3';

// server broadcast messages
const CONNECTION_LIMIT_EXCEEDED = 'connection_limit_exceeded';
const RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded';
const ACCESS_DENIED = 'access_denied';
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
const publicRoomIdToRoomData = new Map();
const privateRoomIdToRoomData = new Map();

// Number of active connections
var connections = 0;

// Port to listen
const port = 443;

// Certificate Path SSL/TLS certificate files
const keyFilePath = path.join(__dirname, 'ssl', 'private.key');
const certFilePath = path.join(__dirname, 'ssl', 'certificate.crt');

// rate limiter options for data transfer and API calls
const opts = {
  points: 30,
  duration: 1,
  blockDuration: 3,
};

const APICallOptions = {
  points: 1,
  duration: 1,
  blockDuration: 3,
};

const rateLimiter = new RateLimiterMemory(opts);
const apiCallRateLimiter = new RateLimiterMemory(APICallOptions);

// Allowed roomId types
const allowedRoomTypes = [PRIVATE_TEXT_CHAT_DUO, PRIVATE_VIDEO_CHAT_DUO, PUBLIC_TEXT_CHAT_MULTI, PRIVATE_TEXT_CHAT_MULTI];

uWS.SSLApp({
  key_file_name: keyFilePath,
  cert_file_name: certFilePath
}).ws('/', {
  compression: uWS.SHARED_COMPRESSOR,
  maxPayloadLength: 1048576,
  maxLifetime: 0,
  idleTimeout: 10,

  upgrade: (res, req, context) => {
    const address = convertArrayBufferToString(res.getRemoteAddressAsText());

    const ipCount = connectionsPerIp.get(address) || 0;
    if (ipCount >= 3) {
      res.writeStatus('403 Forbidden').end(CONNECTION_LIMIT_EXCEEDED);
      return;
    } else {
      connectionsPerIp.set(address, ipCount + 1);
    }

    const roomType = req.getQuery("RT");
    if (!allowedRoomTypes.includes(roomType)) {
      res.writeStatus('403 Forbidden').end(ACCESS_DENIED);
      return;
    }

    const roomName = req.getQuery("RN");
    if (roomName && typeof roomName !== 'string' && roomName.length > 0 && roomName.length <= 160) {
      res.writeStatus('403 Forbidden').end(ACCESS_DENIED);
      return;
    }

    const roomId = req.getQuery("RID");
    if (roomId && typeof roomId !== 'string' && roomId.length === 36) {
      res.writeStatus('403 Forbidden').end(ACCESS_DENIED);
      return;
    }

    if (roomType === PUBLIC_TEXT_CHAT_MULTI || roomType === PRIVATE_TEXT_CHAT_MULTI) {
      if (!roomName && !roomId) {
        res.writeStatus('403 Forbidden').end(ACCESS_DENIED);
        return;
      }
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

  open: (ws) => {
    reconnect(ws, true);
  },

  message: (ws, message, _isBinary) => {
    rateLimiter.consume(ws.id, 1).then((_rateLimiterRes) => {
      const roomId = socketIdToRoomId.get(ws.id);
      if (roomId) ws.publish(roomId, message);
    }).catch((_rateLimiterRes) => {
      ws.send(JSON.stringify({ type: RATE_LIMIT_EXCEEDED }));
    });
  },

  drain: (ws) => {
    console.log('WebSocket backpressure: ' + ws.getBufferedAmount());
  },

  close: (ws, _code, _message) => {
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
  const clientIp = req.getHeader('x-forwarded-for') || req.getHeader('remote-address');
  apiCallRateLimiter.consume(clientIp).then((_rateLimiterRes) => {
    const origin = req.getHeader('origin');

    if (allowedOrigins.includes(origin)) {
      res.writeHeader('Access-Control-Allow-Origin', origin);
      res.writeHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.writeHeader('Access-Control-Allow-Headers', 'Content-Type');

      // Security headers
      res.writeHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://picolon.com; script-src 'self'; style-src 'self';");
      res.writeHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.writeHeader('X-Content-Type-Options', 'nosniff');
      res.writeHeader('X-Frame-Options', 'DENY');
      res.writeHeader('X-XSS-Protection', '1; mode=block');
      res.writeHeader('Referrer-Policy', 'no-referrer');
      res.writeHeader('Permissions-Policy', 'geolocation=(self)');

      res.end(connections.toString());
    } else {
      res.writeStatus('403 Forbidden').end(ACCESS_DENIED);
    }
  }).catch((_rateLimiterRes) => {
    res.writeStatus('429 Too Many Requests').end(RATE_LIMIT_EXCEEDED);
  });
}).get("/api/v1/public-text-chat-rooms", (res, req) => {
  const clientIp = req.getHeader('x-forwarded-for') || req.getHeader('remote-address');

  apiCallRateLimiter.consume(clientIp).then((_rateLimiterRes) => {
    const origin = req.getHeader('origin');

    if (allowedOrigins.includes(origin)) {
      res.writeHeader('Access-Control-Allow-Origin', origin);
      res.writeHeader('Access-Control-Allow-Methods', 'GET');
      res.writeHeader('Access-Control-Allow-Headers', 'Content-Type');

      // Security headers
      res.writeHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://picolon.com; script-src 'self'; style-src 'self';");
      res.writeHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.writeHeader('X-Content-Type-Options', 'nosniff');
      res.writeHeader('X-Frame-Options', 'DENY');
      res.writeHeader('X-XSS-Protection', '1; mode=block');
      res.writeHeader('Referrer-Policy', 'no-referrer');
      res.writeHeader('Permissions-Policy', 'geolocation=(self)');

      // Handle GET requests
      const rooms = Array.from(publicRoomIdToRoomData.values());
      res.end(JSON.stringify(rooms));
    } else {
      res.writeStatus('403 Forbidden').end(ACCESS_DENIED);
    }
  }).catch((rateLimiterRes) => {
    res.writeStatus('429 Too Many Requests').end(RATE_LIMIT_EXCEEDED);
  });
}).any("/*", (res, _req) => {
  res.writeStatus('404 Not Found').end('Resource Not Found');
}).listen(port, (_token) => {
  console.log('Server is running on port', port);
});

const reconnect = async (ws, isConnected = false) => {
  try {
    lock.acquire("reconnect", async (done) => {
      if (isConnected) {
        connections++;
      }

      const roomType = ws.roomType;
      socketIdToRoomType.set(ws.id, roomType);

      if (roomType === PUBLIC_TEXT_CHAT_MULTI || roomType === PRIVATE_TEXT_CHAT_MULTI) {
        if (ws.roomName) {
          const roomId = uuidv4();
          ws.subscribe(roomId);
          socketIdToRoomId.set(ws.id, roomId);
          textChatMultiRoomIdToSockets.set(roomId, new Set([ws]));

          let roomData = {
            roomName: ws.roomName,
            createTime: new Date().getTime(),
            roomId,
            roomType,
            connections: 1
          };

          if (roomType === PRIVATE_TEXT_CHAT_MULTI) {
            privateRoomIdToRoomData.set(roomId, roomData);
          } else {
            publicRoomIdToRoomData.set(roomId, roomData);
          }

          ws.send(JSON.stringify({ type: YOU_ARE_CONNECTED_TO_THE_ROOM, roomData }));
        } else if (ws.roomId) {
          const roomData = roomType === PUBLIC_TEXT_CHAT_MULTI ? publicRoomIdToRoomData.get(ws.roomId) : privateRoomIdToRoomData.get(ws.roomId);

          if (roomData) {
            const socketsInRoom = textChatMultiRoomIdToSockets.get(ws.roomId);
            socketsInRoom.add(ws);
            ws.subscribe(ws.roomId);
            roomData.connections++;
            ws.send(JSON.stringify({ type: YOU_ARE_CONNECTED_TO_THE_ROOM, roomData }));

            ws.publish(ws.roomId, JSON.stringify({
              type: STRANGER_CONNECTED_TO_THE_ROOM,
            }), false, true);

            socketIdToRoomId.set(ws.id, ws.roomId);
            textChatMultiRoomIdToSockets.set(ws.roomId, socketsInRoom);

            if (roomType === PRIVATE_TEXT_CHAT_MULTI) {
              privateRoomIdToRoomData.set(ws.roomId, roomData);
            } else {
              publicRoomIdToRoomData.set(ws.roomId, roomData);
            }
          } else {
            ws.send(JSON.stringify({ type: ROOM_NOT_FOUND }));
            ws.close();
            done();
            return;
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
    }, {});
  } catch (error) {
    console.log('Error in reconnect', error);
  }
}

const handleDisconnect = async (ws) => {
  try {
    lock.acquire("disconnect", async (done) => {
      --connections;

      const roomId = socketIdToRoomId.get(ws.id);
      const roomType = socketIdToRoomType.get(ws.id);
      socketIdToRoomType.delete(ws.id);

      if (roomType === PUBLIC_TEXT_CHAT_MULTI || roomType === PRIVATE_TEXT_CHAT_MULTI) {
        if (roomId) {
          const socketsInRoom = textChatMultiRoomIdToSockets.get(roomId);

          if (socketsInRoom) {
            socketsInRoom.delete(ws);

            if (socketsInRoom.size === 0) {
              textChatMultiRoomIdToSockets.delete(roomId);
              roomType === PRIVATE_TEXT_CHAT_MULTI ? privateRoomIdToRoomData.delete(roomId) : publicRoomIdToRoomData.delete(roomId);
            } else {
              let roomData = roomType === PRIVATE_TEXT_CHAT_MULTI ? privateRoomIdToRoomData.get(roomId) : publicRoomIdToRoomData.get(roomId);
              roomData.connections--;
              roomType === PRIVATE_TEXT_CHAT_MULTI ? privateRoomIdToRoomData.set(roomId, roomData) : publicRoomIdToRoomData.set(roomId, roomData);
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
    }, {});
  } catch (error) {
    console.log('Error in handleDisconnect', error);
  }
}

const convertArrayBufferToString = (arrayBuffer) => {
  const decoder = new TextDecoder();
  return decoder.decode(arrayBuffer);
}