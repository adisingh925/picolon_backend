const { Server } = require("socket.io");
var AsyncLock = require('async-lock');
const handleLog = require("./logging/logger");
var lock = new AsyncLock();
let io;

// maps to store necessary data
const doubleChatRoomWaitingPeople = [];
const doubleVideoRoomWaitingPeople = [];
const doubleChatRooms = new Map();
const doubleVideoRooms = new Map();
const personChoice = new Map();
const socketToRoom = new Map();
const ipConnectionCounts = new Map();

// Socket events
const CONNECTION = "connection";
const DISCONNECT = "disconnect";

// Custom events
const MESSAGE = "message";
const PAIRED = "paired";
const PEER_DISCONNECTED = "peer_disconnected";
const INITIATOR = "initiator";
const WARNING = "warning";

// limits
const MAX_CONNECTIONS_PER_IP = 5;
const MAX_PAYLOAD_SIZE = 1048576;

const setupSocket = (server) => {
    io = new Server(server, {
        cors: {
            origin: ['http://localhost:3000', "https://picolon.com"],
            methods: ['GET', 'POST'],
        },
    });

    io.use((socket, next) => {
        lock.acquire("ipcheck", async () => {
            try {
                handleLog("ipcheck lock acquired for " + socket.handshake.address);

                const ip = socket.handshake.address;

                const connectionCount = ipConnectionCounts.get(ip) || 0;
                if (connectionCount >= MAX_CONNECTIONS_PER_IP) {
                    handleLog(`IP ${ip} exceeded the connection limit.`);
                    return next(new Error(`Only ${MAX_CONNECTIONS_PER_IP} connections per IP are allowed.`));
                } else {
                    handleLog(`IP ${ip} connected with ${connectionCount + 1} connections.`);
                    ipConnectionCounts.set(ip, connectionCount + 1);
                }

                next();
            } catch (error) {
                handleLog(`Error in IP check: ${error.message}`);
            }
        }, function (err, ret) {
            handleLog("ipcheck lock released for " + socket.handshake.address);
        }, {})
    });

    io.on(CONNECTION, (socket) => {
        handleLog(`Client Connected: ${socket.id}`);

        socket.use(async (packet, next) => {
            try {
                const [event, payload] = packet;

                let size;

                if (typeof payload === 'object' && payload.type in ["audio", "video", "image"]) {
                    size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
                } else {
                    handleLog(`Unsupported payload type for socket ${socket.id}`);
                    socket.emit(WARNING, { message: `Unsupported payload type.`, code: 415 });
                    return;
                }

                // Check if the payload size exceeds the maximum allowed size
                if (size > MAX_PAYLOAD_SIZE) {
                    handleLog(`Payload size exceeded the limit for socket ${socket.id}`);
                    socket.emit(WARNING, { message: `Payload size exceeded the limit.`, code: 413 });
                    return;
                }

                next();
            } catch (error) {
                handleLog(`Error in payload size limiter: ${error.message}`);
            }
        });


        reconnect(socket, socket.request._query['RT']);

        // Handle disconnection
        socket.on(DISCONNECT, () => {
            handleLog(`Client Disconnected: ${socket.id}`);
            disconnect(socket);
        });
    });
}

const reconnect = async (socket, roomType) => {
    lock.acquire("reconnect", async (done) => {
        try {
            handleLog("reconnect lock acquired for " + socket.id);

            if (roomType != 1 && roomType != 2) {
                socket.disconnect();
                ipConnectionCounts.delete(socket.handshake.address);
                done();
                return;
            }

            // Save the client's choice
            personChoice.set(socket.id, roomType);

            const waitingPeople = roomType == 1 ? doubleChatRoomWaitingPeople : doubleVideoRoomWaitingPeople;

            var peerSocket = null;

            if (waitingPeople.length > 0) {
                peerSocket = waitingPeople.splice(Math.floor(Math.random() * waitingPeople.length), 1)[0];
            } else {
                waitingPeople.push(socket);
                done();
                return;
            }

            if (peerSocket) {
                // Create a unique room for the two clients
                const room = `${peerSocket.id}#${socket.id}`;

                // Join the room
                socket.join(room);
                peerSocket.join(room);

                // Save room info
                const rooms = roomType == 1 ? doubleChatRooms : doubleVideoRooms;
                rooms.set(room, { socket1: socket, socket2: peerSocket });
                socketToRoom.set(socket.id, room);
                socketToRoom.set(peerSocket.id, room);

                socket.to(room).emit(PAIRED, "You are connected to Stranger");
                peerSocket.to(room).emit(PAIRED, "You are connected to Stranger");

                //If it's a video chat, assign the initiator
                if (roomType == 2) {
                    socket.emit(INITIATOR, "You are the initiator!");
                }

                // Handle messages between paired clients
                socket.on(MESSAGE, (msg) => {
                    socket.to(room).emit(MESSAGE, msg);
                });

                peerSocket.on(MESSAGE, (msg) => {
                    peerSocket.to(room).emit(MESSAGE, msg);
                });
            }

            done();
        } catch (error) {
            handleLog(`Error in reconnect: ${error.message}`);
        }
    }, function (err, ret) {
        handleLog("reconnect lock released for " + socket.id);
    }, {});
}

const disconnect = async (socket) => {
    lock.acquire("disconnect", async (done) => {
        try {
            handleLog("disconnect lock acquired for " + socket.id);

            // Check if the disconnected client was in a room using socketToRoom
            ipConnectionCounts.delete(socket.handshake.address);
            const room = socketToRoom.get(socket.id);
            const roomType = personChoice.get(socket.id);
            personChoice.delete(socket.id);

            if (room) {
                const { socket1, socket2 } = roomType == 1 ? doubleChatRooms.get(room) : doubleVideoRooms.get(room);

                // Notify the remaining client
                const remainingSocket = (socket1.id === socket.id) ? socket2 : socket1;
                remainingSocket.emit(PEER_DISCONNECTED, "Your peer is disconnected");

                // Remove the room from the map
                roomType == 1 ? doubleChatRooms.delete(room) : doubleVideoRooms.delete(room);
                socketToRoom.delete(socket.id);
                socketToRoom.delete(remainingSocket.id);

                done();

                reconnect(remainingSocket, roomType);
            } else {
                // Remove the client from waiting list
                const waitingPeople = roomType == 1 ? doubleChatRoomWaitingPeople : doubleVideoRoomWaitingPeople;
                const index = waitingPeople.indexOf(socket);
                if (index !== -1) {
                    waitingPeople.splice(index, 1);
                }
            }

            done();
        } catch (error) {
            handleLog(`Error in disconnect: ${error.message}`);
        }
    }, function (err, ret) {
        handleLog("disconnect lock released for " + socket.id);
    }, {});
}

module.exports = setupSocket;
