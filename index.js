const uWS = require('uWebSockets.js');
const path = require('path');
require('dotenv').config()
const { RateLimiterMemory } = require("rate-limiter-flexible");
const { v4: uuidv4 } = require('uuid');
const { client: redisClient, subscriber, publisher } = require('./redis');

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
const CONNECTION_REJECTED = 'connection_rejected';
const STRANGER_DISCONNECTED_FROM_THE_ROOM = 'stranger_disconnected_from_the_room';
const YOU_ARE_CONNECTED_TO_THE_ROOM = 'you_are_connected_to_the_room';
const STRANGER_CONNECTED_TO_THE_ROOM = 'stranger_connected_to_the_room';
const ROOM_NOT_FOUND = 'room_not_found';
const DOUBLE_CHAT_ROOM_WAITING_PEOPLE_LIST = "double_chat_room_waiting_people_list";
const DOUBLE_VIDEO_CHAT_ROOM_WAITING_PEOPLE_LIST = "double_video_chat_room_waiting_people_list";

// Rate limiter constants
const RATE_LIMIT_WINDOW = 5;
const MAX_REQUESTS = 5

// Maps to store necessary data
const socketIdToSocket = new Map();

// Number of active connections
const connections = 'connections';
redisClient.set(connections, 0, 'NX');

// Port to listen
const port = 80;

// Certificate Path SSL/TLS certificate files
const keyFilePath = path.join(__dirname, 'ssl', 'private.key');
const certFilePath = path.join(__dirname, 'ssl', 'certificate.crt');

// rate limiter options for data transfer
const opts = {
  points: 10,
  duration: 1,
  blockDuration: 3,
};

const rateLimiter = new RateLimiterMemory(opts);

// Allowed roomId types
const allowedRoomTypes = [PRIVATE_TEXT_CHAT_DUO, PRIVATE_VIDEO_CHAT_DUO, PUBLIC_TEXT_CHAT_MULTI, PRIVATE_TEXT_CHAT_MULTI];

uWS.App({
  key_file_name: keyFilePath,
  cert_file_name: certFilePath
}).ws('/', {
  compression: uWS.SHARED_COMPRESSOR,
  maxPayloadLength: 1048576,
  maxLifetime: 0,
  idleTimeout: 10,

  upgrade: (res, req, context) => {
    const address = convertArrayBufferToString(res.getRemoteAddressAsText());
    const roomType = req.getQuery("RT");
    const roomName = req.getQuery("RN");
    const roomId = req.getQuery("RID");
    const websocketKey = req.getHeader('sec-websocket-key');
    const websocketProtocol = req.getHeader('sec-websocket-protocol');
    const websocketExtensions = req.getHeader('sec-websocket-extensions');

    console.log('address', address);

    redisClient.incr(`ip_address_to_connection_count:${address}`).then((count) => {
      let countInt = parseInt(count);
      if (isNaN(countInt)) {
        countInt = 0;
      }
      if (countInt >= 3) {
        res.cork(() => {
          res.writeStatus('403 Forbidden').end(CONNECTION_LIMIT_EXCEEDED);
        });
        return;
      } else {
        if (!allowedRoomTypes.includes(roomType)) {
          res.cork(() => {
            res.writeStatus('403 Forbidden').end(CONNECTION_REJECTED);
          });
          return;
        }

        if (roomName) {
          if (typeof roomName !== 'string' || !(roomName.length > 0 && roomName.length <= 160)) {
            res.cork(() => {
              res.writeStatus('403 Forbidden').end(CONNECTION_REJECTED);
            });
            return;
          }
        }

        if (roomId) {
          if (typeof roomId !== 'string' || roomId.length !== 36) {
            res.cork(() => {
              res.writeStatus('403 Forbidden').end(CONNECTION_REJECTED);
            });
            return;
          }
        }

        if (roomType === PUBLIC_TEXT_CHAT_MULTI || roomType === PRIVATE_TEXT_CHAT_MULTI) {
          if (!roomName && !roomId) {
            res.cork(() => { res.writeStatus('403 Forbidden').end(CONNECTION_REJECTED); });
            return;
          }
        }

        // Upgrade WebSocket connection
        res.cork(() => {
          res.upgrade(
            { ip: address, roomType, roomName, roomId, id: websocketKey },
            websocketKey,
            websocketProtocol,
            websocketExtensions,
            context
          );
        });
      }
    }).catch((error) => {
      console.log('fetch_ip_count_error', error);
      res.cork(() => { res.writeStatus('403 Forbidden').end(CONNECTION_REJECTED); });
      return;
    });

    res.onAborted(() => {
      console.warn('Request Aborted');
    });
  },

  open: async (ws) => {
    await redisClient.incr(connections);
    reconnect(ws, true);
  },

  message: (ws, message, _isBinary) => {
    let data = convertArrayBufferToString(message);
    rateLimiter.consume(ws.id, 1).then((rateLimiterRes) => {
      redisClient.get(`socket_id_to_room_id:${ws.id}`).then((roomId) => {
        if (roomId) publisher.publish('data', JSON.stringify({ type: "send_message_to_others", socket_id: ws.id, message: data, roomId }));
      }).catch((error) => {
        console.log('Error in getting roomId from socketId', error);
      })
    }).catch((rateLimiterRes) => {
      ws.send(JSON.stringify({ type: RATE_LIMIT_EXCEEDED }));
    });
  },

  drain: (ws) => {
    console.log('WebSocket backpressure: ' + ws.getBufferedAmount());
  },

  close: async (ws, _code, _message) => {
    await redisClient.decr(connections);
    handleDisconnect(ws);
  }
}).get('/api/v1/connections', async (res, req) => {
  res.onAborted(() => {
    console.warn('Request Aborted');
    return;
  });

  const origin = req.getHeader('origin');

  const clientIp = req.getHeader('x-forwarded-for') || req.getHeader('remote-address');
  const isAllowed = await apiRateLimiter(clientIp);

  if (!isAllowed) {
    res.cork(() => {
      res.writeStatus('429 Too Many Requests').end();
    });
    return;
  }

  if (allowedOrigins.includes(origin) || 1) {
    res.cork(() => {
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
    });

    redisClient.get(connections).then((connections) => {
      res.cork(() => {
        res.end(connections);
      });
    }).catch((error) => {
      console.log('Error in getting connections', error);
      res.cork(() => {
        res.writeStatus('500 Internal Server Error').end();
      });
    });
  } else {
    res.cork(() => {
      res.writeStatus('403 Forbidden').end();
    });
  }
}).get("/api/v1/public-text-chat-rooms", async (res, req) => {
  const clientIp = req.getHeader('x-forwarded-for') || req.getHeader('remote-address');
  const isAllowed = await apiRateLimiter(clientIp);

  if (!isAllowed) {
    res.writeStatus('429 Too Many Requests').end();
    return;
  }

  const origin = req.getHeader('origin');

  // Set CORS headers
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
    redisClient.hGetAll("public_room_id_to_room_data")
      .then((rooms) => {
        const roomValues = Object.values(rooms);
        res.cork(() => {
          res.writeHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(roomValues));
        });
      })
      .catch((error) => {
        console.log('Error in fetching public rooms', error);
        res.writeStatus('500 Internal Server Error').end();
      });
  } else {
    res.writeStatus('403 Forbidden').end();
  }

  res.onAborted(() => {
    console.warn('Request Aborted');
  });
}).get("/ping", (res, _req) => {
  res.writeStatus('200 OK').end('pong');
}).any("/*", (res, _req) => {
  res.writeStatus('404 Not Found').end("404 Not Found");
}).listen(port, (_token) => {
  console.log('Server is listening on port', port);
});

const reconnect = async (ws, isConnected = false) => {
  try {
    await redisClient.watch(`socket_id_to_room_id:${ws.id}`);
    const multi = redisClient.multi();

    const roomType = ws.roomType;
    multi.set(`socket_id_to_room_type:${ws.id}`, roomType);

    if (roomType === PUBLIC_TEXT_CHAT_MULTI || roomType === PRIVATE_TEXT_CHAT_MULTI) {
      if (ws.roomName) {
        const roomId = uuidv4();
        socketIdToSocket.set(ws.id, ws);

        multi.set(`socket_id_to_room_id:${ws.id}`, roomId);
        multi.set(`room_id_to_socket_ids:${roomId}`, JSON.stringify([ws.id]));

        let roomData = {
          roomName: ws.roomName,
          createTime: new Date().getTime(),
          roomId,
          roomType,
          connections: 1
        };

        if (roomType === PRIVATE_TEXT_CHAT_MULTI) {
          multi.set(`private_room_id_to_room_data:${roomId}`, JSON.stringify(roomData));
        } else {
          multi.set(`public_room_id_to_room_data:${roomId}`, JSON.stringify(roomData));
        }

        const execResult = await multi.exec();

        if (!execResult) {
          console.log(`error in creating room ${ws.roomName}`);
        } else {
          ws.send(JSON.stringify({ type: YOU_ARE_CONNECTED_TO_THE_ROOM, roomData }));
        }
      } else if (ws.roomId) {
        const roomDataJsonString = await redisClient.get(roomType === PUBLIC_TEXT_CHAT_MULTI ? `public_room_id_to_room_data:${ws.roomId}` : `private_room_id_to_room_data:${ws.roomId}`);
        const roomData = JSON.parse(roomDataJsonString);

        if (roomData) {
          const socketIdsInRoomJsonString = await redisClient.get(`room_id_to_socket_ids:${ws.roomId}`);
          const socketIdsInRoom = JSON.parse(socketIdsInRoomJsonString);
          socketIdsInRoom.push(ws.id);
          socketIdToSocket.set(ws.id, ws);

          roomData.connections++;

          multi.set(`socket_id_to_room_id:${ws.id}`, ws.roomId);
          multi.set(`room_id_to_socket_ids:${ws.roomId}`, JSON.stringify(socketIdsInRoom));

          if (roomType === PRIVATE_TEXT_CHAT_MULTI) {
            multi.set(`private_room_id_to_room_data:${ws.roomId}`, JSON.stringify(roomData));
          } else {
            multi.set(`public_room_id_to_room_data:${ws.roomId}`, JSON.stringify(roomData));
          }

          const execResult = await multi.exec();
          if (!execResult) {
            console.log(`error in reconnecting to room ${ws.roomId}`);
          } else {
            ws.send(JSON.stringify({ type: YOU_ARE_CONNECTED_TO_THE_ROOM, roomData }));
            publisher.publish('data', JSON.stringify({ type: "send_message_to_others", socket_id: ws.id, roomId: ws.roomId, message: JSON.stringify({ type: STRANGER_CONNECTED_TO_THE_ROOM }) }));
          }
        } else {
          ws.send(JSON.stringify({ type: ROOM_NOT_FOUND }));
          ws.close();
          return;
        }
      }
    } else {
      let waitingListKey = roomType === PRIVATE_TEXT_CHAT_DUO ? DOUBLE_CHAT_ROOM_WAITING_PEOPLE_LIST : DOUBLE_VIDEO_CHAT_ROOM_WAITING_PEOPLE_LIST;
      const peerSocketId = await redisClient.lIndex(waitingListKey, 0);
      socketIdToSocket.set(ws.id, ws);

      if (peerSocketId) {
        const roomId = uuidv4();

        // setting room id to socket ids mapping in redis
        multi.set(`room_id_to_socket_ids:${roomId}`, JSON.stringify([ws.id, peerSocketId]));

        // setting room id to socket id mapping in redis
        multi.set(`socket_id_to_room_id:${ws.id}`, roomId);
        multi.set(`socket_id_to_room_id:${peerSocketId}`, roomId);
        multi.lRem(waitingListKey, 1, peerSocketId);

        const execResult = await multi.exec();

        if (!execResult) {
          console.log(`error in creating room for ${roomType}`);
        } else {
          // notifying both the sockets that they are connected to each other
          const message = JSON.stringify({ type: 'paired', message: "You are connected to Stranger" });

          publisher.publish('data', JSON.stringify({ type: "send_message", socket_id: ws.id, message }));
          publisher.publish('data', JSON.stringify({ type: "send_message", socket_id: peerSocketId, message }));

          // notifying the initiator if its a video chat duo room
          if (roomType === PRIVATE_VIDEO_CHAT_DUO) {
            publisher.publish('data', JSON.stringify({ type: "send_message", socket_id: ws.id, message: JSON.stringify({ type: 'initiator', message: "You are the initiator!" }) }));
          }
        }
      } else {
        multi.lPush(waitingListKey, ws.id);

        const execResult = await multi.exec();
        if (!execResult) {
          console.log(`error in adding to waiting list for ${roomType}`);
        } else {
          console.log(`added to waiting list for ${roomType}`);
        }
      }
    }
  } catch (error) {
    console.log('Error in reconnect', error);
  }
}

const handleDisconnect = async (ws) => {
  try {
    await redisClient.watch(`socket_id_to_room_id:${ws.id}`);
    const multi = redisClient.multi();

    multi.decr(`ip_address_to_connection_count:${ws.ip}`);

    const roomId = await redisClient.get(`socket_id_to_room_id:${ws.id}`);
    const roomType = await redisClient.get(`socket_id_to_room_type:${ws.id}`);

    if (roomType === PUBLIC_TEXT_CHAT_MULTI || roomType === PRIVATE_TEXT_CHAT_MULTI) {
      if (roomId) {
        const socketsInRoomJsonString = await redisClient.get(`room_id_to_socket_ids:${roomId}`);
        let socketsInRoom = JSON.parse(socketsInRoomJsonString);

        if (socketsInRoom) {
          socketsInRoom = socketsInRoom.filter(id => id !== ws.id);
          socketIdToSocket.delete(ws.id);

          if (socketsInRoom.length === 0) {
            multi.del(`room_id_to_socket_ids:${roomId}`);
            multi.del(roomType === PRIVATE_TEXT_CHAT_MULTI ? `private_room_id_to_room_data:${roomId}` : `public_room_id_to_room_data:${roomId}`);
          } else {
            const roomDataJsonString = await redisClient.get(roomType === PRIVATE_TEXT_CHAT_MULTI ? `private_room_id_to_room_data:${roomId}` : `public_room_id_to_room_data:${roomId}`);
            const roomData = JSON.parse(roomDataJsonString);
            roomData.connections--;
            multi.set(roomType === PRIVATE_TEXT_CHAT_MULTI ? `private_room_id_to_room_data:${roomId}` : `public_room_id_to_room_data:${roomId}`, JSON.stringify(roomData));
            multi.set(`room_id_to_socket_ids:${roomId}`, JSON.stringify(socketsInRoom));
            multi.del(`socket_id_to_room_type:${ws.id}`);
            multi.del(`socket_id_to_room_id:${ws.id}`);

            const execResult = await multi.exec();

            if (!execResult) {
              console.log(`error in removing from room ${roomId}`);
            } else {
              publisher.publish('data', JSON.stringify({ type: "send_message_to_others", socket_id: ws.id, roomId, message: JSON.stringify({ type: STRANGER_DISCONNECTED_FROM_THE_ROOM }) }));
            }
          }
        }
      }
    } else {
      if (roomId) {
        const socketsInRoomJsonString = await redisClient.get(`room_id_to_socket_ids:${roomId}`);
        const socketsInRoom = JSON.parse(socketsInRoomJsonString);
        const [socket1Id, socket2Id] = socketsInRoom;

        const remainingSocketId = (socket1Id === ws.id) ? socket2Id : socket1Id;

        multi.del(`room_id_to_socket_ids:${roomId}`);
        multi.del(`socket_id_to_room_id:${ws.id}`);
        multi.del(`socket_id_to_room_id:${remainingSocketId}`);

        const execResult = await multi.exec();

        if (!execResult) {
          console.log(`error in removing from room ${roomId}`);
        } else {
          socketIdToSocket.delete(ws.id);
          publisher.publish('data', JSON.stringify({ type: "send_message_to_id_and_reconnect", socket_id: remainingSocketId, message: JSON.stringify({ type: 'peer_disconnected', message: "Your peer is disconnected" }) }));
        }
      } else {
        const listKey = roomType === PRIVATE_TEXT_CHAT_DUO ? DOUBLE_CHAT_ROOM_WAITING_PEOPLE_LIST : DOUBLE_VIDEO_CHAT_ROOM_WAITING_PEOPLE_LIST;
        const waitingPeople = await redisClient.lRange(listKey, 0, -1);
        const index = waitingPeople.indexOf(ws.id);
        if (index !== -1) multi.lRem(listKey, 1, ws.id);

        const execResult = await multi.exec();
        if (!execResult) {
          console.log(`error in removing from waiting list for ${roomType}`);
        } else {
          console.log(`removed from waiting list for ${roomType}`);
          socketIdToSocket.delete(ws.id);
        }
      }
    }
  } catch (error) {
    console.log('Error in handleDisconnect', error);
  }
}

const convertArrayBufferToString = (arrayBuffer) => {
  const decoder = new TextDecoder();
  return decoder.decode(arrayBuffer);
}

subscriber.subscribe('data', async (message) => {
  try {
    const data = JSON.parse(message);
    if (data.type === "send_message") {
      const socket = socketIdToSocket.get(data.socket_id);
      if (socket) {
        socket.send(data.message);
      }
    } else if (data.type === "send_message_to_others") {
      const socketsInRoomJsonString = await redisClient.get(`room_id_to_socket_ids:${data.roomId}`);
      let socketsInRoom = JSON.parse(socketsInRoomJsonString);

      socketsInRoom.forEach(socketId => {
        if (socketId !== data.socket_id) {
          const socket = socketIdToSocket.get(socketId);

          if (socket) {
            socket.send(data.message);
          }
        }
      });
    } else if (data.type === "send_message_to_id_and_reconnect") {
      const socket = socketIdToSocket.get(data.socket_id);

      if (socket) {
        socket.send(data.message);
        reconnect(socket, true);
      }
    }
  } catch (error) {
    console.log('Error in handling message', error.message);
  }
});

async function apiRateLimiter(clientIp) {
  const key = `rate_limit:${clientIp}`;
  const currentCount = await redisClient.incr(key);

  if (currentCount === 1) {
    await redisClient.expire(key, RATE_LIMIT_WINDOW);
  }

  if (currentCount > MAX_REQUESTS) {
    return false;
  }

  return true;
}