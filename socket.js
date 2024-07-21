const { Server } = require("socket.io");
let io;

const waitingClients = []; // List to keep track of waiting clients
const rooms = new Map(); // Map to keep track of active rooms and their members

// Socket events
const CONNECTION = "connection";
const DISCONNECT = "disconnect";

// Custom events
const MESSAGE = "message";
const PAIRED = "Paired";
const PEER_DISCONNECTED = "peerDisconnected";

const setupSocket = (server) => {
    io = new Server(server);

    io.on(CONNECTION, (socket) => {
        console.log(`Client Connected: ${socket.id}`);

        // If there's at least one client waiting, pair them with the new client
        if (waitingClients.length > 0) {
            const peerSocket = waitingClients.pop(); // Get the waiting client
            const room = `${peerSocket.id}#${socket.id}`; // Create a unique room for the two clients

            socket.join(room);
            peerSocket.join(room);

            // Save room info
            rooms.set(room, { socket1: socket, socket2: peerSocket });

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

        // Handle disconnection
        socket.on(DISCONNECT, () => {
            console.log(`Client Disconnected: ${socket.id}`);

            // Check if the disconnected client was in a room
            for (const [room, clients] of rooms.entries()) {
                if (clients.socket1.id === socket.id || clients.socket2.id === socket.id) {
                    // Notify the remaining client
                    const remainingSocket = (clients.socket1.id === socket.id) ? clients.socket2 : clients.socket1;
                    remainingSocket.emit(PEER_DISCONNECTED, "Your peer is disconnected");

                    // Remove the room
                    rooms.delete(room);

                    // Optionally, add the remaining client back to the waiting list
                    waitingClients.push(remainingSocket);
                    break;
                }
            }

            // Remove the disconnected client from the waiting list if present
            const index = waitingClients.indexOf(socket);
            if (index !== -1) {
                waitingClients.splice(index, 1);
            }
        });
    });
}

module.exports = setupSocket;
