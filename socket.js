const { Server } = require("socket.io");
var AsyncLock = require('async-lock');
var lock = new AsyncLock();
let io;

const waitingClients = []; // List to keep track of waiting clients
const rooms = new Map(); // Map to keep track of active rooms and their members

// Socket events
const CONNECTION = "connection";
const DISCONNECT = "disconnect";

// Custom events
const MESSAGE = "message";
const PAIRED = "paired";
const PEER_DISCONNECTED = "peer_disconnected";

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
        reconnect(socket);

        // Handle disconnection
        socket.on(DISCONNECT, () => {
            console.log(`Client Disconnected: ${socket.id}`);
            disconnect(socket);
        });
    });
}

const reconnect = async (socket) => {
    lock.acquire("reconnect", async () => {
        // If there's at least one client waiting, pair them with the new client
        if (waitingClients.length > 0) {

            // Randomly select a client
            const peerSocket = waitingClients.splice(Math.floor(Math.random() * waitingClients.length), 1)[0];

            // Create a unique room for the two clients
            const room = `${peerSocket.id}#${socket.id}`; 

            // Join the room
            socket.join(room);
            peerSocket.join(room);

            // Save room info
            rooms.set(room, { socket1: socket, socket2: peerSocket });
            socketToRoom.set(socket.id, room);
            socketToRoom.set(peerSocket.id, room);

            socket.to(room).emit(PAIRED, "You are now connected to -> " + peerSocket.id);
            peerSocket.to(room).emit(PAIRED, "You are now connected to -> " + socket.id);

            // Handle messages between paired clients
            socket.on(MESSAGE, (msg) => {
                socket.to(room).emit(MESSAGE, msg);
            });

            peerSocket.on(MESSAGE, (msg) => {
                peerSocket.to(room).emit(MESSAGE, msg);
            });
        } else {
            // If no clients are waiting, add the new client to the waiting list
            waitingClients.push(socket);
        }
    }, function (err, ret) {
        console.log("reconnect lock release");
    }, {});
}

const disconnect = async (socket) => {
    lock.acquire("disconnect", async (done) => {
        // Check if the disconnected client was in a room using socketToRoom
        const room = socketToRoom.get(socket.id);
        if (room) {
            const { socket1, socket2 } = rooms.get(room);

            // Notify the remaining client
            const remainingSocket = (socket1.id === socket.id) ? socket2 : socket1;
            remainingSocket.emit(PEER_DISCONNECTED, "Your peer is disconnected");

            // Remove the room
            rooms.delete(room);
            socketToRoom.delete(socket.id);
            socketToRoom.delete(remainingSocket.id);

            done();

            reconnect(remainingSocket);
        } else {
            // Remove the client from waiting list
            const index = waitingClients.indexOf(socket);
            if (index !== -1) {
                waitingClients.splice(index, 1);
            }
        }

        done();
    }, function (err, ret) {
        console.log("disconnect lock release")
    }, {});
}

module.exports = setupSocket;
