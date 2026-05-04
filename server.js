const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

class SimpleNoise {
    constructor(seed = 1) { this.seed = seed; }
    random(x, z) { 
        const sin = Math.sin(Math.floor(x) * 12.9898 + Math.floor(z) * 78.233 + this.seed) * 43758.5453;
        return sin - Math.floor(sin);
    }
    getNoise(x, z) {
        const intX = Math.floor(x); const intZ = Math.floor(z); const fractX = x - intX; const fractZ = z - intZ;
        const v1 = this.random(intX, intZ); const v2 = this.random(intX + 1, intZ); const v3 = this.random(intX, intZ + 1); const v4 = this.random(intX + 1, intZ + 1);
        const fX = (1 - Math.cos(fractX * Math.PI)) * 0.5; const fZ = (1 - Math.cos(fractZ * Math.PI)) * 0.5;
        const i1 = v1 * (1 - fX) + v2 * fX; const i2 = v3 * (1 - fX) + v4 * fX;
        return (i1 * (1 - fZ) + i2 * fZ) * 2.0 - 1.0;
    }
}

// ✨ THE FIX: The Server now uses the same coordinate space as the Player camera.
function getBlockAt(x, y, z, seed, customBlocks) {
    const bx = Math.floor(x); const by = Math.floor(y); const bz = Math.floor(z);
    const key = `${bx},${by},${bz}`;
    if (customBlocks[key]) return customBlocks[key];
    
    const noise = new SimpleNoise(seed); const rough = new SimpleNoise(seed + 1337);
    const tempMap = new SimpleNoise(seed + 555);
    
    // We calculate elevation exactly as the client renders it (True World Y)
    let height = Math.floor((noise.getNoise(bx * 0.015, bz * 0.015) + 1) * 8 + rough.getNoise(bx * 0.06, bz * 0.06) * 3) + 2;
    
    if (by <= height) return 'stone';
    return 'air';
}

function checkCollisionServer(x, y, z, seed, customBlocks) {
    const radius = 0.25; // Exact Minecraft player/mob collision radius
    const feetY = y; 
    const headY = y + 1.7; 
    
    // Check points around the entity to mimic AABB collision from Player_17.js
    const pMinX = Math.floor(x - radius + 0.5); 
    const pMaxX = Math.floor(x + radius + 0.5); 
    const pMinY = Math.floor(feetY + 0.5); 
    const pMaxY = Math.floor(headY + 0.5); 
    const pMinZ = Math.floor(z - radius + 0.5); 
    const pMaxZ = Math.floor(z + radius + 0.5);
    
    for (let bx = pMinX; bx <= pMaxX; bx++) {
        for (let by = pMinY; by <= pMaxY; by++) {
            for (let bz = pMinZ; bz <= pMaxZ; bz++) {
                const type = getBlockAt(bx, by, bz, seed, customBlocks);
                if (type !== 'air' && type !== 'water' && type !== 'torch') {
                    if (feetY < by + 0.5 && headY > by - 0.5) return true;
                }
            }
        }
    }
    return false;
}

function getTrueSurfaceY(x, z, seed, customBlocks) {
    for(let y = 30; y >= -30; y--) { 
        if(getBlockAt(x, y, z, seed, customBlocks) !== 'air') return y; 
    }
    return 10; 
}

const sessions = {}; let globalIdCounter = 0;

io.on('connection', (socket) => {
    socket.on('createGame', (playerName) => {
        const roomId = socket.id; 
        sessions[roomId] = { seed: Math.floor(Math.random() * 10000), hostName: playerName || "Guest", players: {}, blocks: {}, drops: {}, mobs: {}, startTime: Date.now(), lastSpawnTime: 0 };
        joinRoom(socket, roomId, playerName);
    });

    socket.on('joinGame', (data) => { if(sessions[data.roomId]) joinRoom(socket, data.roomId, data.playerName); });

    function joinRoom(socket, roomId, playerName) {
        socket.join(roomId); socket.roomId = roomId; const room = sessions[roomId];
        room.players[socket.id] = { name: playerName || "Guest", x: 16, y: 15, z: 16, ry: 0, rx: 0, heldItem: null, isAttacking: false, health: 100 };
        socket.emit('world_snapshot', { seed: room.seed, players: room.players, blocks: room.blocks, drops: room.drops, mobs: room.mobs, ageInSeconds: 0, isHost: true });
    }

    socket.on('move', (data) => { if(socket.roomId && sessions[socket.roomId]?.players[socket.id]) { Object.assign(sessions[socket.roomId].players[socket.id], data); socket.broadcast.to(socket.roomId).emit('playerMoved', { id: socket.id, ...data }); } });
    
    socket.on('requestMobAttack', (data) => {
        const room = sessions[socket.roomId];
        if (room && room.mobs[data.id]) {
            room.mobs[data.id].health -= data.dmg;
            if (room.mobs[data.id].health <= 0) {
                const type = room.mobs[data.id].type.toUpperCase();
                delete room.mobs[data.id];
                io.in(socket.roomId).emit('mobKilled', { mobId: data.id, killerName: room.players[socket.id].name, mobType: type });
            } else {
                io.in(socket.roomId).emit('mobDamaged', { id: data.id, kbDir: data.kbDir });
            }
        }
    });

    socket.on('disconnect', () => { if(socket.roomId && sessions[socket.roomId]) delete sessions[socket.roomId].players[socket.id]; });
});

setInterval(() => {
    for (let roomId in sessions) {
        const room = sessions[roomId]; const playerIds = Object.keys(room.players); if (playerIds.length === 0) continue;
        const now = Date.now();

        // Spawning
        if (Object.keys(room.mobs).length < 10 && (now - room.lastSpawnTime > 3000)) {
            const targetPlayer = room.players[playerIds[0]];
            const angle = Math.random() * Math.PI * 2; const dist = 15 + Math.random() * 10;
            const mx = targetPlayer.x + Math.cos(angle) * dist; const mz = targetPlayer.z + Math.sin(angle) * dist;
            let my = getTrueSurfaceY(mx, mz, room.seed, room.blocks);
            
            const id = 'mob_' + globalIdCounter++;
            room.mobs[id] = { id, type: Math.random() > 0.5 ? 'zombie' : 'archer', x: mx, y: my + 1, z: mz, vy: 0, ry: 0, health: 100, isMoving: true };
            room.lastSpawnTime = now;
            io.in(roomId).emit('mobSpawned', room.mobs[id]);
        }

        for (let mobId in room.mobs) {
            let mob = room.mobs[mobId];
            
            // Basic Gravity
            mob.vy -= 25.0 * 0.05; 
            let nextY = mob.y + (mob.vy * 0.05);

            if (checkCollisionServer(mob.x, nextY, mob.z, room.seed, room.blocks)) {
                if (mob.vy < 0) {
                    mob.y = Math.floor(nextY - 0.5) + 0.5 + 1.0; 
                    mob.vy = 0;
                }
            } else {
                mob.y = nextY;
            }

            // Fall off edges check
            if (mob.y < -40) { delete room.mobs[mobId]; io.in(roomId).emit('mobDespawned', mobId); }
        }
        io.in(roomId).emit('server_tick', { players: room.players, mobs: room.mobs });
    }
}, 50);

server.listen(3000, () => console.log(`Server running on port 3000`));
