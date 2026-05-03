const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Enable CORS with explicit methods to guarantee connections
const io = new Server(server, { 
    cors: { 
        origin: "*",
        methods: ["GET", "POST"] 
    } 
});

// Store active worlds/rooms
const sessions = {}; 

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    // Function to send the list of active worlds to everyone
    const broadcastLobby = () => {
        const activeWorlds = Object.keys(sessions).map(id => ({ 
            id: id, 
            hostName: sessions[id].hostName, 
            playerCount: Object.keys(sessions[id].players).length 
        }));
        io.emit('lobbyUpdate', activeWorlds);
    };

    // Send the lobby list immediately when someone opens the menu
    broadcastLobby();

    // 1. HOST A NEW WORLD
    socket.on('createGame', (playerName) => {
        const roomId = socket.id; // Host's socket ID is the room ID
        sessions[roomId] = { 
            hostName: playerName || "Guest", 
            players: {}, 
            startTime: Date.now() // Track when the world started for Time Sync
        };
        joinRoom(socket, roomId, playerName);
        broadcastLobby(); // Update menu for everyone else
    });

    // 2. JOIN AN EXISTING WORLD
    socket.on('joinGame', (data) => {
        if(sessions[data.roomId]) {
            joinRoom(socket, data.roomId, data.playerName);
            broadcastLobby();
        }
    });

    // Handle the actual room joining logic
    function joinRoom(socket, roomId, playerName) {
        socket.join(roomId);
        socket.roomId = roomId;
        const room = sessions[roomId];

        room.players[socket.id] = { name: playerName || "Guest", x: 16, y: 30, z: 16, ry: 0, rx: 0 };

        // Send current room state AND the age of the world for Day/Night sync
        socket.emit('currentPlayers', {
            players: room.players,
            ageInSeconds: (Date.now() - room.startTime) / 1000 
        });

        // Tell everyone else in THIS SPECIFIC ROOM that someone joined
        socket.to(roomId).emit('newPlayer', { id: socket.id, player: room.players[socket.id] });
    }

    // 3. MOVEMENT & BLOCKS (Now isolated to the specific room)
    socket.on('move', (data) => {
        if(socket.roomId && sessions[socket.roomId]) {
            const player = sessions[socket.roomId].players[socket.id];
            
            // ✨ BUG FIX: Update the coordinates, but PRESERVE the name!
            if (player) {
                player.x = data.x;
                player.y = data.y;
                player.z = data.z;
                player.ry = data.ry;
                player.rx = data.rx;
            }
            
            socket.to(socket.roomId).emit('playerMoved', { id: socket.id, ...data });
        }
    });

    socket.on('blockUpdate', (data) => {
        if(socket.roomId) socket.to(socket.roomId).emit('blockUpdate', data);
    });

    // 4. CLEAN UP ON DISCONNECT
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        if(socket.roomId && sessions[socket.roomId]) {
            const room = sessions[socket.roomId];
            delete room.players[socket.id];
            socket.to(socket.roomId).emit('playerDisconnected', socket.id);

            // If the HOST left, destroy the room
            if(socket.roomId === socket.id) {
                socket.to(socket.roomId).emit('hostLeft');
                delete sessions[socket.roomId];
            }
            broadcastLobby(); // Update player counts on menu
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Multiplayer Server running on port ${PORT}`);
});
