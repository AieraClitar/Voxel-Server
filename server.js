const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] } 
});

const sessions = {}; 
let dropIdCounter = 0;

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    const broadcastLobby = () => {
        const activeWorlds = Object.keys(sessions).map(id => ({ 
            id: id, hostName: sessions[id].hostName, playerCount: Object.keys(sessions[id].players).length 
        }));
        io.emit('lobbyUpdate', activeWorlds);
    };

    broadcastLobby();

    // 1. HOST A NEW WORLD
    socket.on('createGame', (playerName) => {
        const roomId = socket.id; 
        sessions[roomId] = { 
            hostId: socket.id, 
            hostName: playerName || "Guest", 
            players: {}, 
            blocks: {}, // ✨ SERVER TRUTH: Stores all block modifications
            drops: {},  // ✨ SERVER TRUTH: Stores all active items
            mobs: [],   // Caches mob states
            startTime: Date.now()
        };
        joinRoom(socket, roomId, playerName);
        broadcastLobby(); 
    });

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

        room.players[socket.id] = { 
            name: playerName || "Guest", 
            x: 16, y: 30, z: 16, ry: 0, rx: 0,
            heldItem: null, isAttacking: false, health: 100
        };

        // ✨ FULL WORLD SNAPSHOT ON JOIN
        // Client must completely overwrite their local state with this data
        socket.emit('world_snapshot', {
            players: room.players,
            blocks: room.blocks,
            drops: room.drops,
            mobs: room.mobs,
            ageInSeconds: (Date.now() - room.startTime) / 1000,
            isHost: socket.id === room.hostId 
        });

        socket.to(roomId).emit('newPlayer', { id: socket.id, player: room.players[socket.id] });
    }

    // --- CONTINUOUS STATE REPLICATION ---

    socket.on('move', (data) => {
        if(socket.roomId && sessions[socket.roomId]) {
            const player = sessions[socket.roomId].players[socket.id];
            if (player) Object.assign(player, data);
            socket.to(socket.roomId).emit('playerMoved', { id: socket.id, ...data });
        }
    });

    // ✨ SERVER VALIDATES BLOCK BREAKS
    socket.on('requestBlockBreak', (data) => {
        const room = sessions[socket.roomId];
        if (!room) return;
        const key = `${data.x},${data.y},${data.z}`;
        
        if (room.blocks[key] === 'air') return; // Prevent double break
        
        room.blocks[key] = 'air'; // Save to Server Truth
        io.in(socket.roomId).emit('blockUpdate', { action: 'remove', x: data.x, y: data.y, z: data.z });

        // Server decides to spawn the drop
        const dropId = 'drop_' + dropIdCounter++;
        const dropData = { id: dropId, x: data.x, y: data.y, z: data.z, type: data.type };
        room.drops[dropId] = dropData;
        io.in(socket.roomId).emit('item_spawned', dropData); // Emit to everyone
    });

    // ✨ SERVER VALIDATES BLOCK PLACES
    socket.on('requestBlockPlace', (data) => {
        const room = sessions[socket.roomId];
        if (!room) return;
        const key = `${data.x},${data.y},${data.z}`;
        
        room.blocks[key] = data.type; // Save to Server Truth
        io.in(socket.roomId).emit('blockUpdate', { action: 'add', x: data.x, y: data.y, z: data.z, type: data.type });
    });

    // ✨ ANTI-DUPLICATION VALIDATION
    socket.on('pickupDrop', (data) => {
        if(socket.roomId && sessions[socket.roomId]) {
            // ONLY grant the item if it actually still exists on the server!
            if (sessions[socket.roomId].drops[data.id]) {
                delete sessions[socket.roomId].drops[data.id];
                
                // 1. Tell the player who picked it up to add it to their inventory
                socket.emit('pickupSuccess', data.type);
                // 2. Tell everyone to remove the mesh from the ground
                io.in(socket.roomId).emit('item_removed', data.id);
            }
        }
    });

    socket.on('spawnDrop', (data) => {
        if(socket.roomId && sessions[socket.roomId]) {
            const dropId = 'drop_' + dropIdCounter++;
            const dropData = { id: dropId, ...data };
            sessions[socket.roomId].drops[dropId] = dropData;
            io.in(socket.roomId).emit('item_spawned', dropData); 
        }
    });

    socket.on('mobSync', (mobData) => {
        if(socket.roomId && sessions[socket.roomId]) {
            sessions[socket.roomId].mobs = mobData; 
            socket.to(socket.roomId).emit('mobSync', mobData);
        }
    });

    socket.on('clientHitMob', (data) => {
        if(socket.roomId && sessions[socket.roomId]) {
            const hostId = sessions[socket.roomId].hostId;
            io.to(hostId).emit('mobDamagedByClient', data);
        }
    });

    socket.on('disconnect', () => {
        if(socket.roomId && sessions[socket.roomId]) {
            const room = sessions[socket.roomId];
            delete room.players[socket.id];
            socket.to(socket.roomId).emit('playerDisconnected', socket.id);

            if(room.hostId === socket.id) {
                socket.to(socket.roomId).emit('hostLeft');
                delete sessions[socket.roomId];
            }
            broadcastLobby(); 
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Multiplayer Server running on port ${PORT}`));
