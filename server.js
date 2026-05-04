const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] } 
});

const sessions = {}; 

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    const broadcastLobby = () => {
        const activeWorlds = Object.keys(sessions).map(id => ({ 
            id: id, hostName: sessions[id].hostName, playerCount: Object.keys(sessions[id].players).length 
        }));
        io.emit('lobbyUpdate', activeWorlds);
    };

    broadcastLobby();

    // 1. HOST A NEW WORLD (Becomes the Server Authority)
    socket.on('createGame', (playerName) => {
        const roomId = socket.id; 
        sessions[roomId] = { 
            hostId: socket.id, 
            hostName: playerName || "Guest", 
            players: {}, 
            startTime: Date.now()
        };
        joinRoom(socket, roomId, playerName);
        broadcastLobby(); 
    });

    // 2. JOIN AN EXISTING WORLD (Becomes a Client)
    socket.on('joinGame', (data) => {
        if(sessions[data.roomId]) {
            joinRoom(socket, data.roomId, data.playerName);
            broadcastLobby();
        }
    });

    function joinRoom(socket, roomId, playerName) {
        socket.join(roomId);
        socket.roomId = roomId;
        const room = sessions[roomId];

        // Advanced State Tracking
        room.players[socket.id] = { 
            name: playerName || "Guest", 
            x: 16, y: 30, z: 16, ry: 0, rx: 0,
            heldItem: null, isAttacking: false, health: 100
        };

        socket.emit('currentPlayers', {
            players: room.players,
            ageInSeconds: (Date.now() - room.startTime) / 1000,
            isHost: socket.id === room.hostId // Inform the client if they control the AI
        });

        socket.to(roomId).emit('newPlayer', { id: socket.id, player: room.players[socket.id] });
    }

    // 3. PLAYER SYNC (Now handles animations, health, and inventory)
    socket.on('move', (data) => {
        if(socket.roomId && sessions[socket.roomId]) {
            const player = sessions[socket.roomId].players[socket.id];
            if (player) Object.assign(player, data);
            socket.to(socket.roomId).emit('playerMoved', { id: socket.id, ...data });
        }
    });

    // 4. AUTHORITATIVE MOB SYNC (Host to Clients)
    socket.on('mobSync', (mobData) => {
        if(socket.roomId) socket.to(socket.roomId).emit('mobSync', mobData);
    });

    // 5. COMBAT SYNC (Clients requesting to damage a Host's mob)
    socket.on('clientHitMob', (data) => {
        if(socket.roomId && sessions[socket.roomId]) {
            const hostId = sessions[socket.roomId].hostId;
            io.to(hostId).emit('mobDamagedByClient', data);
        }
    });

    socket.on('blockUpdate', (data) => {
        if(socket.roomId) socket.to(socket.roomId).emit('blockUpdate', data);
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        if(socket.roomId && sessions[socket.roomId]) {
            const room = sessions[socket.roomId];
            delete room.players[socket.id];
            socket.to(socket.roomId).emit('playerDisconnected', socket.id);

            // If the Authority leaves, the room closes
            if(room.hostId === socket.id) {
                socket.to(socket.roomId).emit('hostLeft');
                delete sessions[socket.roomId];
            }
            broadcastLobby(); 
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Multiplayer Server running on port ${PORT}`);
});
