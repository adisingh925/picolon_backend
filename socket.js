const { Server } = require("socket.io");
var AsyncLock = require('async-lock');
var lock = new AsyncLock();
let io;

const doubleChatRoomWaitingPeople = [];
const doubleVideoRoomWaitingPeople = [];
const doubleChatRooms = new Map();
const doubleVideoRooms = new Map();
const personChoice = new Map();
const socketToRoom = new Map(); // Map to quickly find which room a socket is in

// Socket events
const CONNECTION = "connection";
const DISCONNECT = "disconnect";

// Custom events
const MESSAGE = "message";
const PAIRED = "paired";
const PEER_DISCONNECTED = "peer_disconnected";
const INITIATOR = "initiator";


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
    lock.acquire("reconnect", async (done) => {

        if (roomType != 1 && roomType != 2) {
            socket.disconnect();
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

        done();
    }, function (err, ret) {
        console.log("reconnect lock release");
    }, {});
}

const disconnect = async (socket) => {
    lock.acquire("disconnect", async (done) => {
        // Check if the disconnected client was in a room using socketToRoom
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
    }, function (err, ret) {
        console.log("disconnect lock release")
    }, {});
}

module.exports = setupSocket;
