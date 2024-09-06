const uWS = require('uWebSockets.js');
const path = require('path');
const AsyncLock = require('async-lock');
const lock = new AsyncLock();
require('dotenv').config()
const { RateLimiterMemory } = require("rate-limiter-flexible");
const { v4: uuidv4 } = require('uuid');
const sendEmail = require('./Reporting/ErrorReporting');
const { validate: uuidValidate } = require('uuid');

const WEBSITE_URL = "https://picolon.com";
const allowedOrigins = [WEBSITE_URL];

//constants
const PRIVATE_TEXT_CHAT_DUO = '0';
const PRIVATE_VIDEO_CHAT_DUO = '1';
const PUBLIC_TEXT_CHAT_MULTI = '2';
const PRIVATE_TEXT_CHAT_MULTI = '3';

// server broadcast messages types
const RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED';
const ACCESS_DENIED = 'ACCESS_DENIED';
const RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND';
const STRANGER_DISCONNECTED_FROM_THE_ROOM = 'STRANGER_DISCONNECTED_FROM_THE_ROOM';
const YOU_ARE_CONNECTED_TO_THE_ROOM = 'YOU_ARE_CONNECTED_TO_THE_ROOM';
const STRANGER_CONNECTED_TO_THE_ROOM = 'STRANGER_CONNECTED_TO_THE_ROOM';
const ROOM_NOT_FOUND = 'ROOM_NOT_FOUND';
const PAIRED = "PAIRED";
const PEER_DISCONNECTED = "PEER_DISCONNECTED";
const INITIATOR = "INITIATOR";

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
  points: 3,
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
    /**
     * Get the IP address of the client
     */
    const address = convertArrayBufferToString(res.getRemoteAddressAsText());

    /**
     * Check if the IP address is valid
     */
    if (!validateIPAddress(address)) {
      res.writeStatus('403 Forbidden').end(ACCESS_DENIED);
      return;
    }

    /**
     * Check if the client has exceeded the connection limit
     */
    const ipCount = connectionsPerIp.get(address) || 0;

    if (ipCount >= 3) {
      res.writeStatus('403 Forbidden').end(ACCESS_DENIED);
      return;
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
    if (roomId && typeof roomId !== 'string' && uuidValidate(roomId)) {
      res.writeStatus('403 Forbidden').end(ACCESS_DENIED);
      return;
    }

    if ([PUBLIC_TEXT_CHAT_MULTI, PRIVATE_TEXT_CHAT_MULTI].includes(roomType)) {
      if (!roomName && !roomId) {
        res.writeStatus('403 Forbidden').end(ACCESS_DENIED);
        return;
      }
    }

    connectionsPerIp.set(address, ipCount + 1);

    /**
     * Upgrade the connection to WebSocket
     */
    res.upgrade(
      { ip: address, roomType, roomName, roomId, id: req.getHeader('sec-websocket-key') },
      req.getHeader('sec-websocket-key'),
      req.getHeader('sec-websocket-protocol'),
      req.getHeader('sec-websocket-extensions'),
      context
    );
  },

  /**
   * Handling new connection open event
   * @param {*} ws 
   */
  open: (ws) => {
    /**
     * Handle the connection open event
     */
    reconnect(ws, true);
  },

  /**
   * Handling the incoming messages
   * @param {*} ws 
   * @param {*} message 
   * @param {*} _isBinary 
   */
  message: (ws, message, _isBinary) => {
    rateLimiter.consume(ws.id, 1).then((_rateLimiterRes) => {
      const roomId = socketIdToRoomId.get(ws.id);
      if (roomId) ws.publish(roomId, message);
    }).catch((_rateLimiterRes) => {
      ws.send(JSON.stringify({ type: RATE_LIMIT_EXCEEDED }));
    });
  },

  /**
   * Handling the backpressure
   * @param {*} ws 
   */
  drain: (ws) => {
    console.log('WebSocket backpressure: ' + ws.getBufferedAmount());
  },

  /**
   * Handling the connection close event
   * @param {*} ws 
   * @param {*} _code 
   * @param {*} _message 
   */
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
      setResponseHeaders(res, origin);
      res.end(connections.toString());
    } else {
      res.writeStatus('403 Forbidden').writeHeader('Content-Type', 'application/json').end(JSON.stringify({
        error: ACCESS_DENIED,
        message: 'You do not have permission to access this resource.',
        code: 403
      }));
    }
  }).catch((_rateLimiterRes) => {
    res.writeStatus('429 Too Many Requests').writeHeader('Content-Type', 'application/json').end(JSON.stringify({
      error: RATE_LIMIT_EXCEEDED,
      message: 'You have exceeded the rate limit. Please try again later.',
      code: 429
    }));
  });
}).get("/api/v1/public-text-chat-rooms", (res, req) => {
  const clientIp = req.getHeader('x-forwarded-for') || req.getHeader('remote-address');

  apiCallRateLimiter.consume(clientIp).then((_rateLimiterRes) => {
    const origin = req.getHeader('origin');

    if (allowedOrigins.includes(origin)) {
      setResponseHeaders(res, origin);
      const rooms = Array.from(publicRoomIdToRoomData.values());
      res.end(JSON.stringify(rooms));
    } else {
      res.writeStatus('403 Forbidden').writeHeader('Content-Type', 'application/json').end(JSON.stringify({
        error: ACCESS_DENIED,
        message: 'You do not have permission to access this resource.',
        code: 403
      }));
    }
  }).catch((_rateLimiterRes) => {
    res.writeStatus('429 Too Many Requests').writeHeader('Content-Type', 'application/json').end(JSON.stringify({
      error: RATE_LIMIT_EXCEEDED,
      message: 'You have exceeded the rate limit. Please try again later.',
      code: 429
    }));
  });
}).post("/api/v1/report-error", (res, req) => {
  res.onAborted(() => {
    console.log('Request Aborted');
  });

  const clientIp = req.getHeader('x-forwarded-for') || req.getHeader('remote-address');

  apiCallRateLimiter.consume(clientIp).then((_rateLimiterRes) => {
    const origin = req.getHeader('origin');

    if (allowedOrigins.includes(origin)) {
      setResponseHeaders(res, origin);

      let buffer = Buffer.from('');

      res.onData((chunk, isLast) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

        if (isLast) {
          try {
            const body = JSON.parse(buffer.toString());

            sendEmail(
              ["adisingh925@gmail.com"],
              {
                errorMessage: body.errorMessage,
                timestamp: body.timestamp,
                stackTrace: body.stackTrace,
              },
              body.errorMessage,
              "Templates/error-report.hbs",
              "error-reporting",
              "Picolon UI Error Report"
            );

            res.writeStatus('200 OK');
            res.writeHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              message: 'Error reported successfully',
              code: 200
            }));
          } catch (e) {
            res.writeStatus('400 Bad Request');
            res.writeHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'Invalid JSON',
              code: 400
            }));
          }
        }
      });
    } else {
      res.writeStatus('403 Forbidden').writeHeader('Content-Type', 'application/json').end(JSON.stringify({
        error: ACCESS_DENIED,
        message: 'You do not have permission to access this resource.',
        code: 403
      }));
    }
  }).catch((_rateLimiterRes) => {
    res.writeStatus('429 Too Many Requests').writeHeader('Content-Type', 'application/json').end(JSON.stringify({
      error: RATE_LIMIT_EXCEEDED,
      message: 'You have exceeded the rate limit. Please try again later.',
      code: 429
    }));
  });
}).any("/*", (res, _req) => {
  res.writeStatus('404 Not Found').writeHeader('Content-Type', 'application/json').end(JSON.stringify({
    error: RESOURCE_NOT_FOUND,
    message: 'The requested resource could not be found.',
    code: 404
  }));
}).listen(port, (_token) => {
  console.log('Server is running on port', port);
});

/**
 * Function to reconnect the client
 * @param {*} ws 
 * @param {*} isConnected 
 */
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

            socketIdToRoomId.set(ws.id, ws.roomId);
            textChatMultiRoomIdToSockets.set(ws.roomId, socketsInRoom);

            roomData.connections++;

            if (roomType === PRIVATE_TEXT_CHAT_MULTI) {
              privateRoomIdToRoomData.set(ws.roomId, roomData);
            } else {
              publicRoomIdToRoomData.set(ws.roomId, roomData);
            }

            ws.subscribe(ws.roomId);
            ws.send(JSON.stringify({ type: YOU_ARE_CONNECTED_TO_THE_ROOM, roomData }));
            ws.publish(ws.roomId, JSON.stringify({
              type: STRANGER_CONNECTED_TO_THE_ROOM,
            }), false, true);
          } else {
            ws.send(JSON.stringify({ type: ROOM_NOT_FOUND }));
            ws.close();
            done();
            return;
          }
        }
      } else {
        const waitingPeople = roomType === PRIVATE_TEXT_CHAT_DUO ? doubleChatRoomWaitingPeople : doubleVideoRoomWaitingPeople;
        const peerSocket = waitingPeople.length > 0 ? waitingPeople.pop() : null;

        if (peerSocket) {
          const roomId = uuidv4();

          const rooms = roomType === PRIVATE_TEXT_CHAT_DUO ? textChatDuoRoomIdToSockets : videoChatDuoRoomIdToSockets;
          rooms.set(roomId, { socket1: ws, socket2: peerSocket });
          socketIdToRoomId.set(ws.id, roomId);
          socketIdToRoomId.set(peerSocket.id, roomId);

          peerSocket.subscribe(roomId);
          ws.subscribe(roomId);

          ws.send(JSON.stringify({ type: PAIRED, message: "You are connected to Stranger" }));
          peerSocket.send(JSON.stringify({ type: PAIRED, message: "You are connected to Stranger" }));

          if (roomType === PRIVATE_VIDEO_CHAT_DUO) {
            ws.send(JSON.stringify({ type: INITIATOR, message: "You are the initiator!" }));
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

/**
 * Function to handle the disconnect event
 * @param {*} ws 
 */
const handleDisconnect = async (ws) => {
  try {
    lock.acquire("disconnect", async (done) => {
      --connections;

      const roomId = socketIdToRoomId.get(ws.id);
      const roomType = socketIdToRoomType.get(ws.id);
      socketIdToRoomType.delete(ws.id);

      if (roomId && (roomType === PUBLIC_TEXT_CHAT_MULTI || roomType === PRIVATE_TEXT_CHAT_MULTI)) {
        const socketsInRoom = textChatMultiRoomIdToSockets.get(roomId);
        socketIdToRoomId.delete(ws.id);

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
      } else {
        if (roomId) {
          const rooms = roomType === PRIVATE_TEXT_CHAT_DUO ? textChatDuoRoomIdToSockets : videoChatDuoRoomIdToSockets;
          const { socket1, socket2 } = rooms.get(roomId);
          const remainingSocket = (socket1.id === ws.id) ? socket2 : socket1;
          remainingSocket.send(JSON.stringify({ type: PEER_DISCONNECTED, message: "Your peer is disconnected" }));
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

/**
 * Function to convert ArrayBuffer to string
 * @param {*} arrayBuffer 
 * @returns 
 */
const convertArrayBufferToString = (arrayBuffer) => {
  const decoder = new TextDecoder();
  return decoder.decode(arrayBuffer);
}

/**
 * This function sets the response headers
 * @param {*} res 
 * @param {*} origin 
 */
function setResponseHeaders(res, origin) {
  res.writeHeader('Access-Control-Allow-Origin', origin);
  res.writeHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, POST');
  res.writeHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Security headers
  res.writeHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://picolon.com; script-src 'self'; style-src 'self';");
  res.writeHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.writeHeader('X-Content-Type-Options', 'nosniff');
  res.writeHeader('X-Frame-Options', 'DENY');
  res.writeHeader('X-XSS-Protection', '1; mode=block');
  res.writeHeader('Referrer-Policy', 'no-referrer');
  res.writeHeader('Permissions-Policy', 'geolocation=(self)');
}

function validateIPAddress(ip) {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Regex = /^([\da-f]{1,4}:){7}[\da-f]{1,4}$/i;

  if (ipv4Regex.test(ip)) {
    return ip.split('.').every(part => parseInt(part) <= 255);
  }

  if (ipv6Regex.test(ip)) {
    return ip.split(':').every(part => part.length <= 4);
  }

  return false;
}