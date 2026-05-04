const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// Server-side deterministic noise for Headless Mob Terrain Collision
class SimpleNoise {
    constructor(seed = 1) { this.seed = seed; }
    random(x, z) { let n = x * 331 + z * 337 + this.seed; n = (n << 13) ^ n; return (1.0 - ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824.0); }
    getNoise(x, z) {
        const intX = Math.floor(x); const intZ = Math.floor(z); const fractX = x - intX; const fractZ = z - intZ;
        const v1 = this.random(intX, intZ); const v2 = this.random(intX + 1, intZ); const v3 = this.random(intX, intZ + 1); const v4 = this.random(intX + 1, intZ + 1);
        const i1 = v1 * (1 - fractX) + v2 * fractX; const i2 = v3 * (1 - fractX) + v4 * fractX;
        return i1 * (1 - fractZ) + i2 * fractZ;
    }
}

const sessions = {}; 
let globalIdCounter = 0;

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    const broadcastLobby = () => {
        const activeWorlds = Object.keys(sessions).map(id => ({ 
            id: id, hostName: sessions[id].hostName, playerCount: Object.keys(sessions[id].players).length 
        }));
        io.emit('lobbyUpdate', activeWorlds);
    };

    broadcastLobby();

    socket.on('createGame', (playerName) => {
        const roomId = socket.id; 
        sessions[roomId] = { 
            seed: Math.floor(Math.random() * 100000), // ✨ SERVER TRUTH: Master World Seed
            hostName: playerName || "Guest", 
            players: {}, 
            blocks: {}, // Server block overrides
            drops: {},  // Server item drops
            mobs: {},   // Server AI entities
            startTime: Date.now()
        };
        joinRoom(socket, roomId, playerName);
        broadcastLobby(); 
    });

    socket.on('joinGame', (data) => {
        if(sessions[data.roomId]) { joinRoom(socket, data.roomId, data.playerName); broadcastLobby(); }
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

        // ✨ FULL WORLD SNAPSHOT ON JOIN: Wipes client independence
        socket.emit('world_snapshot', {
            seed: room.seed,
            players: room.players,
            blocks: room.blocks,
            drops: room.drops,
            mobs: room.mobs,
            ageInSeconds: (Date.now() - room.startTime) / 1000
        });

        socket.to(roomId).emit('newPlayer', { id: socket.id, player: room.players[socket.id] });
    }

    // --- CLIENT INPUT RECEIVERS (Intents Only) ---

    socket.on('move', (data) => {
        if(socket.roomId && sessions[socket.roomId] && sessions[socket.roomId].players[socket.id]) {
            Object.assign(sessions[socket.roomId].players[socket.id], data);
        }
    });

    socket.on('requestBlockBreak', (data) => {
        const room = sessions[socket.roomId]; if (!room) return;
        const key = `${data.x},${data.y},${data.z}`;
        
        if (room.blocks[key] === 'air') return; // Strict Anti-Dupe Check
        
        room.blocks[key] = 'air'; 
        io.in(socket.roomId).emit('blockUpdate', { action: 'remove', x: data.x, y: data.y, z: data.z });

        const dropId = 'drop_' + globalIdCounter++;
        const dropData = { id: dropId, x: data.x, y: data.y, z: data.z, type: data.type };
        room.drops[dropId] = dropData;
        io.in(socket.roomId).emit('item_spawned', dropData); 
    });

    socket.on('requestBlockPlace', (data) => {
        const room = sessions[socket.roomId]; if (!room) return;
        const key = `${data.x},${data.y},${data.z}`;
        
        room.blocks[key] = data.type; 
        io.in(socket.roomId).emit('blockUpdate', { action: 'add', x: data.x, y: data.y, z: data.z, type: data.type });
    });

    socket.on('requestDropItem', (data) => {
        const room = sessions[socket.roomId]; if (!room) return;
        const dropId = 'drop_' + globalIdCounter++;
        const dropData = { id: dropId, ...data };
        room.drops[dropId] = dropData;
        io.in(socket.roomId).emit('item_spawned', dropData); 
    });

    socket.on('requestPickup', (dropId) => {
        const room = sessions[socket.roomId];
        if(room && room.drops[dropId]) {
            const itemType = room.drops[dropId].type;
            delete room.drops[dropId]; // ATOMIC SERVER OPERATION: Kills duplication
            socket.emit('pickupSuccess', itemType);
            io.in(socket.roomId).emit('item_removed', dropId);
        }
    });

    socket.on('requestMobAttack', (data) => {
        const room = sessions[socket.roomId];
        if (room && room.mobs[data.id]) {
            room.mobs[data.id].health -= data.dmg;
            io.in(socket.roomId).emit('mobDamaged', { id: data.id, kbDir: data.kbDir });
            
            if (room.mobs[data.id].health <= 0) {
                delete room.mobs[data.id];
                io.in(socket.roomId).emit('mobKilled', data.id);
            }
        }
    });

    socket.on('disconnect', () => {
        if(socket.roomId && sessions[socket.roomId]) {
            delete sessions[socket.roomId].players[socket.id];
            socket.to(socket.roomId).emit('playerDisconnected', socket.id);
            if(Object.keys(sessions[socket.roomId].players).length === 0) delete sessions[socket.roomId]; // Clean empty rooms
            broadcastLobby(); 
        }
    });
});

// ✨ 20 TPS SERVER GAME LOOP: Drives Mobs and broadcasts state
setInterval(() => {
    for (let roomId in sessions) {
        const room = sessions[roomId];
        const noise = new SimpleNoise(room.seed);
        const playerIds = Object.keys(room.players);
        if (playerIds.length === 0) continue;

        // 1. Spawner
        if (Object.keys(room.mobs).length < 10 && Math.random() < 0.05) {
            const targetPlayer = room.players[playerIds[Math.floor(Math.random() * playerIds.length)]];
            const angle = Math.random() * Math.PI * 2;
            const dist = 15 + Math.random() * 20;
            const mx = targetPlayer.x + Math.cos(angle) * dist;
            const mz = targetPlayer.z + Math.sin(angle) * dist;
            
            // Server calculates terrain height
            let elevation = (noise.getNoise(mx * 0.015, mz * 0.015) + 1) * 8;
            let my = Math.floor(elevation + (new SimpleNoise(1337).getNoise(mx * 0.06, mz * 0.06)) * 3) + 2;

            const id = 'mob_' + globalIdCounter++;
            room.mobs[id] = {
                id: id, type: Math.random() > 0.5 ? 'zombie' : 'archer',
                x: mx, y: my + 1.5, z: mz, ry: 0, rx: 0, health: 100, isMoving: false
            };
            io.in(roomId).emit('mobSpawned', room.mobs[id]);
        }

        // 2. Simple Mob AI Pathfinding
        for (let mobId in room.mobs) {
            let mob = room.mobs[mobId];
            let closestPlayer = null; let minD = 9999;
            
            for (let pid in room.players) {
                let p = room.players[pid];
                let d = Math.sqrt(Math.pow(p.x - mob.x, 2) + Math.pow(p.z - mob.z, 2));
                if (d < minD) { minD = d; closestPlayer = p; }
            }

            if (closestPlayer && minD > 1.5 && minD < 40) {
                const angle = Math.atan2(closestPlayer.x - mob.x, closestPlayer.z - mob.z);
                mob.ry = angle;
                mob.x += Math.sin(angle) * 0.15;
                mob.z += Math.cos(angle) * 0.15;
                
                // Headless terrain sticking
                let elevation = (noise.getNoise(mob.x * 0.015, mob.z * 0.015) + 1) * 8;
                mob.y = Math.floor(elevation + (new SimpleNoise(1337).getNoise(mob.x * 0.06, mob.z * 0.06)) * 3) + 3.5;
                mob.isMoving = true;
            } else {
                mob.isMoving = false;
            }
        }

        // 3. Broadcast TICK UPDATE
        io.in(roomId).emit('server_tick', { players: room.players, mobs: room.mobs });
    }
}, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Multiplayer Server running on port ${PORT}`));
