const { Server } = require("socket.io");
var AsyncLock = require('async-lock');
var lock = new AsyncLock();
let io;

const doubleChatRoomWaitingPeople = [];
const doubleVideoRoomWaitingPeople = [];
const doubleChatRooms = new Map();
const doubleVideoRooms = new Map();
const personChoice = new Map();

// Socket events
const CONNECTION = "connection";
const DISCONNECT = "disconnect";

// Custom events
const MESSAGE = "message";
const PAIRED = "paired";
const PEER_DISCONNECTED = "peer_disconnected";
const INITIATOR = "initiator";

const socketToRoom = new Map(); // Map to quickly find which room a socket is in

const setupSocket = (server) => {
    io = new Server(server, {
        cors: {
            origin: ['http://localhost:3000', "https://picolon.com"], // Replace with your client's origin if different
            methods: ['GET', 'POST'],
        },
    });

    io.on(CONNECTION, (socket) => {
        console.log(`Client Connected: ${socket.id}`);

        reconnect(socket, socket.request._query['RT']);

        // Handle disconnection
        socket.on(DISCONNECT, () => {
            console.log(`Client Disconnected: ${socket.id}`);
            disconnect(socket);
        });
    });
}

const reconnect = async (socket, roomType) => {
    lock.acquire("reconnect", async () => {
        if (roomType == 1 || roomType == 2) {
            // Save the client's choice
            personChoice.set(socket.id, roomType);

            // If there's at least one client waiting, pair them with the new client
            var peerSocket = null;

            if (roomType == 1) {
                if (doubleChatRoomWaitingPeople.length > 0) {
                    peerSocket = doubleChatRoomWaitingPeople.splice(Math.floor(Math.random() * doubleChatRoomWaitingPeople.length), 1)[0];
                } else {
                    doubleChatRoomWaitingPeople.push(socket);
                }
            } else if (roomType == 2) {
                if (doubleVideoRoomWaitingPeople.length > 0) {
                    peerSocket = doubleVideoRoomWaitingPeople.splice(Math.floor(Math.random() * doubleVideoRoomWaitingPeople.length), 1)[0];
                } else {
                    doubleVideoRoomWaitingPeople.push(socket);
                }
            }

            if (peerSocket != null) {
                // Create a unique room for the two clients
                const room = `${peerSocket.id}#${socket.id}`;

                // Join the room
                socket.join(room);
                peerSocket.join(room);

                // Save room info
                if (roomType == 1) {
                    doubleChatRooms.set(room, { socket1: socket, socket2: peerSocket });
                } else if (roomType == 2) {
                    doubleVideoRooms.set(room, { socket1: socket, socket2: peerSocket });
                }

                socketToRoom.set(socket.id, room);
                socketToRoom.set(peerSocket.id, room);

                socket.to(room).emit(PAIRED, peerSocket.id);
                peerSocket.to(room).emit(PAIRED, socket.id);

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
        } else {
            socket.disconnect();
        }
    }, function (err, ret) {
        console.log("reconnect lock release");
    }, {});
}

const disconnect = async (socket) => {
    lock.acquire("disconnect", async (done) => {
        // Check if the disconnected client was in a room using socketToRoom
        const room = socketToRoom.get(socket.id);
        const roomType = personChoice.get(socket.id);

        if (room) {
            const { socket1, socket2 } = room == 1 ? doubleChatRooms.get(room) : doubleVideoRooms.get(room);

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
            if (roomType == 1) {
                const index = doubleChatRoomWaitingPeople.indexOf(socket);
                if (index !== -1) {
                    doubleChatRoomWaitingPeople.splice(index, 1);
                }
            } else if (roomType == 2) {
                const index = doubleVideoRoomWaitingPeople.indexOf(socket);
                if (index !== -1) {
                    doubleVideoRoomWaitingPeople.splice(index, 1);
                }
            }
        }

        done();
    }, function (err, ret) {
        console.log("disconnect lock release")
    }, {});
}

module.exports = setupSocket;
