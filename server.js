const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// ✨ THE FIX: Exact mathematical match to your client's Noise.js
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

// ✨ THE FIX: Removed the Y_OFFSET entirely so the server Y maps exactly to the client Y
function getBlockAt(x, y, z, seed, customBlocks) {
    const bx = Math.floor(x); const by = Math.floor(y); const bz = Math.floor(z);
    const key = `${bx},${by},${bz}`;
    if (customBlocks[key]) return customBlocks[key];
    
    const noise = new SimpleNoise(seed); const rough = new SimpleNoise(seed + 1337); const trees = new SimpleNoise(seed + 888);
    const tempMap = new SimpleNoise(seed + 555);
    
    let elevation = Math.floor((noise.getNoise(bx * 0.015, bz * 0.015) + 1) * 8 + rough.getNoise(bx * 0.06, bz * 0.06) * 3) + 2;
    let isTundra = tempMap.getNoise(bx * 0.005, bz * 0.005) < -0.25;
    
    if (by <= elevation) return 'stone';
    if (!isTundra && by > elevation && by <= elevation + 5 && trees.getNoise(bx * 0.02, bz * 0.02) > 0.1 && Math.abs(trees.random(bx, bz)) < 0.03) return 'wood'; 
    return 'air';
}

function checkCollisionServer(x, y, z, seed, customBlocks) {
    const radius = 0.3; const feetY = y; const headY = y + 1.6;
    const pMinX = Math.floor(x - radius); const pMaxX = Math.floor(x + radius);
    const pMinY = Math.floor(feetY); const pMaxY = Math.floor(headY);
    const pMinZ = Math.floor(z - radius); const pMaxZ = Math.floor(z + radius);
    
    for (let bx = pMinX; bx <= pMaxX; bx++) {
        for (let by = pMinY; by <= pMaxY; by++) {
            for (let bz = pMinZ; bz <= pMaxZ; bz++) {
                if (getBlockAt(bx, by, bz, seed, customBlocks) !== 'air') return true;
            }
        }
    }
    return false;
}

function hasLineOfSight(x1, y1, z1, x2, y2, z2, seed, customBlocks) {
    let dist = Math.sqrt(Math.pow(x2-x1, 2) + Math.pow(y2-y1, 2) + Math.pow(z2-z1, 2));
    let dx = (x2-x1)/dist; let dy = (y2-y1)/dist; let dz = (z2-z1)/dist;
    for(let i=0.5; i<dist; i+=0.5) { if (getBlockAt(x1 + dx*i, y1 + dy*i, z1 + dz*i, seed, customBlocks) !== 'air') return false; }
    return true;
}

function getTrueSurfaceY(x, z, seed, customBlocks) {
    for(let y = 60; y >= -30; y--) { if(getBlockAt(x, y, z, seed, customBlocks) !== 'air') return y; }
    return -28; 
}

const sessions = {}; let globalIdCounter = 0;

io.on('connection', (socket) => {
    const broadcastLobby = () => { io.emit('lobbyUpdate', Object.keys(sessions).map(id => ({ id: id, hostName: sessions[id].hostName, playerCount: Object.keys(sessions[id].players).length }))); };
    broadcastLobby();

    socket.on('createGame', (playerName) => {
        const roomId = socket.id; 
        sessions[roomId] = { seed: Math.floor(Math.random() * 10000), hostName: playerName || "Guest", players: {}, blocks: {}, drops: {}, mobs: {}, startTime: Date.now(), lastSpawnTime: 0 };
        joinRoom(socket, roomId, playerName); broadcastLobby(); 
    });

    socket.on('joinGame', (data) => { if(sessions[data.roomId]) { joinRoom(socket, data.roomId, data.playerName); broadcastLobby(); } });

    function joinRoom(socket, roomId, playerName) {
        socket.join(roomId); socket.roomId = roomId; const room = sessions[roomId];
        room.players[socket.id] = { name: playerName || "Guest", x: 16, y: 10, z: 16, ry: 0, rx: 0, heldItem: null, isAttacking: false, health: 100 };
        socket.emit('world_snapshot', { seed: room.seed, players: room.players, blocks: room.blocks, drops: room.drops, mobs: room.mobs, ageInSeconds: (Date.now() - room.startTime) / 1000, isHost: socket.id === room.hostId });
        socket.to(roomId).emit('newPlayer', { id: socket.id, player: room.players[socket.id] });
    }

    socket.on('move', (data) => { if(socket.roomId && sessions[socket.roomId] && sessions[socket.roomId].players[socket.id]) { Object.assign(sessions[socket.roomId].players[socket.id], data); socket.broadcast.to(socket.roomId).emit('playerMoved', { id: socket.id, ...data }); } });
    socket.on('requestBlockBreak', (data) => { const room = sessions[socket.roomId]; if (!room) return; const key = `${Math.floor(data.x)},${Math.floor(data.y)},${Math.floor(data.z)}`; const actualType = room.blocks[key] || data.type; if (actualType === 'air') return; room.blocks[key] = 'air'; io.in(socket.roomId).emit('blockUpdate', { action: 'remove', x: data.x, y: data.y, z: data.z, type: actualType }); const dropId = 'drop_' + globalIdCounter++; const dropData = { id: dropId, x: data.x, y: data.y, z: data.z, type: actualType }; room.drops[dropId] = dropData; io.in(socket.roomId).emit('item_spawned', dropData); });
    socket.on('requestBlockPlace', (data) => { const room = sessions[socket.roomId]; if (!room) return; const key = `${Math.floor(data.x)},${Math.floor(data.y)},${Math.floor(data.z)}`; room.blocks[key] = data.type; io.in(socket.roomId).emit('blockUpdate', { action: 'add', x: data.x, y: data.y, z: data.z, type: data.type }); });
    socket.on('requestDropItem', (data) => { const room = sessions[socket.roomId]; if (!room) return; const dropId = 'drop_' + globalIdCounter++; const dropData = { id: dropId, ...data }; room.drops[dropId] = dropData; io.in(socket.roomId).emit('item_spawned', dropData); });
    socket.on('requestPickup', (dropId) => { const room = sessions[socket.roomId]; if(room && room.drops[dropId]) { const itemType = room.drops[dropId].type; delete room.drops[dropId]; socket.emit('pickupSuccess', itemType); io.in(socket.roomId).emit('item_removed', dropId); } });
    socket.on('requestPlayerDamage', (data) => { const room = sessions[socket.roomId]; if (room && room.players[socket.id]) { room.players[socket.id].health -= data.dmg; io.in(socket.roomId).emit('playerDamaged', { id: socket.id, dmg: data.dmg, source: data.source }); } });
    
    socket.on('requestMobAttack', (data) => {
        const room = sessions[socket.roomId];
        if (room && room.mobs[data.id]) {
            room.mobs[data.id].health -= data.dmg; io.in(socket.roomId).emit('mobDamaged', { id: data.id, kbDir: data.kbDir });
            if (room.mobs[data.id].health <= 0) { const mobType = room.mobs[data.id].type.toUpperCase(); delete room.mobs[data.id]; io.in(socket.roomId).emit('mobKilled', { mobId: data.id, killerName: room.players[socket.id].name, mobType: mobType }); }
        }
    });

    socket.on('playerRespawn', () => { if(socket.roomId && sessions[socket.roomId] && sessions[socket.roomId].players[socket.id]) sessions[socket.roomId].players[socket.id].health = 100; });
    socket.on('disconnect', () => { if(socket.roomId && sessions[socket.roomId]) { delete sessions[socket.roomId].players[socket.id]; socket.to(socket.roomId).emit('playerDisconnected', socket.id); if(sessions[socket.roomId].hostId === socket.id) { socket.to(socket.roomId).emit('hostLeft'); delete sessions[socket.roomId]; } broadcastLobby(); } });
});

setInterval(() => {
    const now = Date.now();
    for (let roomId in sessions) {
        const room = sessions[roomId]; const playerIds = Object.keys(room.players); if (playerIds.length === 0) continue;
        const dayTime = ((now - room.startTime) / 1000 / 240.0) % 1; const isDay = Math.sin(dayTime * Math.PI * 2) > 0.1;

        if (Object.keys(room.mobs).length < 15 && (now - room.lastSpawnTime > 2500)) {
            const spawnChance = isDay ? 0.05 : 0.2; 
            if (Math.random() < spawnChance) {
                const targetPlayer = room.players[playerIds[Math.floor(Math.random() * playerIds.length)]];
                const angle = Math.random() * Math.PI * 2; 
                // ✨ FIX: Spawn distance is closer (15 to 25 blocks) so you can actually see them appear
                const dist = 15 + Math.random() * 10; 
                const mx = targetPlayer.x + Math.cos(angle) * dist; const mz = targetPlayer.z + Math.sin(angle) * dist;
                let my = getTrueSurfaceY(mx, mz, room.seed, room.blocks);

                if (getBlockAt(mx, my+1, mz, room.seed, room.blocks) === 'air' && getBlockAt(mx, my+2, mz, room.seed, room.blocks) === 'air') { 
                    const id = 'mob_' + globalIdCounter++; 
                    const isZombie = Math.random() > 0.20; 
                    const faceType = isZombie ? 'zombie_face' : 'archer_face';
                    const zombieWeapons = ['none', 'wooden_sword', 'stone_sword', 'wooden_axe', 'stone_pickaxe', 'wooden_shovel'];
                    const archerWeapons = ['bow', 'crossbow', 'gun'];
                    const weapon = isZombie ? zombieWeapons[Math.floor(Math.random() * zombieWeapons.length)] : archerWeapons[Math.floor(Math.random() * archerWeapons.length)];

                    room.mobs[id] = { 
                        id: id, type: isZombie ? 'zombie' : 'archer', weapon: weapon, face: faceType, 
                        x: mx, y: my + 1.0, z: mz, vy: 0, ry: 0, rx: 0, health: 100, isMoving: false, isAttacking: false, isBurning: false, attackTimer: 0, isGrounded: false
                    };
                    room.lastSpawnTime = now; io.in(roomId).emit('mobSpawned', room.mobs[id]);
                }
            }
        }

        for (let mobId in room.mobs) {
            let mob = room.mobs[mobId]; let closestPlayer = null; let minD = 9999;
            for (let pid in room.players) {
                let p = room.players[pid]; if (p.health <= 0) continue;
                let d = Math.sqrt(Math.pow(p.x - mob.x, 2) + Math.pow(p.y - mob.y, 2) + Math.pow(p.z - mob.z, 2));
                if (d < minD) { minD = d; closestPlayer = {id: pid, ...p}; }
            }

            if (mob.attackTimer > 0) mob.attackTimer -= 0.05; 
            mob.isBurning = false; const mobSpeed = mob.type === 'zombie' ? 4.5 : 3.5;

            let hasRoof = false;
            for(let ty = Math.floor(mob.y); ty < Math.floor(mob.y)+20; ty++) { if(getBlockAt(mob.x, ty, mob.z, room.seed, room.blocks) !== 'air') { hasRoof = true; break; } }
            
            if (mob.type === 'zombie' && isDay && !hasRoof) {
                mob.isBurning = true; 
                if (Math.random() < 0.1) {
                    mob.health -= 5; io.in(roomId).emit('mobDamaged', { id: mob.id, kbDir: {x:0, y:0, z:0} });
                    if (mob.health <= 0) { 
                        delete room.mobs[mobId]; 
                        io.in(roomId).emit('mobDespawned', mobId); 
                        continue; 
                    }
                }
            }

            let targetX = 0, targetZ = 0;
            let los = closestPlayer ? hasLineOfSight(mob.x, mob.y + 1.5, mob.z, closestPlayer.x, closestPlayer.y + 1.5, closestPlayer.z, room.seed, room.blocks) : false;

            if (mob.isBurning && !closestPlayer) {
                mob.ry += 0.5; targetX = Math.sin(mob.ry) * mobSpeed * 0.05; targetZ = Math.cos(mob.ry) * mobSpeed * 0.05; mob.isMoving = true;
            } else if (closestPlayer && minD < 20 && los) {
                const angle = Math.atan2(closestPlayer.x - mob.x, closestPlayer.z - mob.z); mob.ry = angle;
                
                if (mob.type === 'zombie') {
                    if (minD > 1.8) { targetX = Math.sin(angle) * mobSpeed * 0.05; targetZ = Math.cos(angle) * mobSpeed * 0.05; mob.isMoving = true; mob.isAttacking = false; } 
                    else {
                        mob.isMoving = false;
                        if (mob.attackTimer <= 0) { 
                            mob.attackTimer = 1.5; mob.isAttacking = true; 
                            let dmg = 10; if(mob.weapon.includes('sword')) dmg = 25; else if(mob.weapon.includes('axe')) dmg = 20; else if(mob.weapon !== 'none') dmg = 15;
                            room.players[closestPlayer.id].health -= dmg; io.in(roomId).emit('playerDamaged', { id: closestPlayer.id, dmg: dmg, source: 'Zombie' }); 
                        } else mob.isAttacking = false;
                    }
                } else if (mob.type === 'archer') {
                    if (minD > 12.0) { targetX = Math.sin(angle) * mobSpeed * 0.05; targetZ = Math.cos(angle) * mobSpeed * 0.05; mob.isMoving = true; mob.isAttacking = false; } 
                    else if (minD < 6.0) { targetX = -Math.sin(angle) * mobSpeed * 0.05; targetZ = -Math.cos(angle) * mobSpeed * 0.05; mob.isMoving = true; mob.isAttacking = false; } 
                    else { mob.isMoving = false; }
                    
                    if (minD <= 20.0 && mob.attackTimer <= 0 && los) { 
                        mob.attackTimer = mob.weapon === 'gun' ? 1.5 : 3.0; mob.isAttacking = true; 
                        io.in(roomId).emit('mobShoot', { type: mob.weapon, from: { x: mob.x, y: mob.y + 1.2, z: mob.z }, to: { x: closestPlayer.x, y: closestPlayer.y + 1.5, z: closestPlayer.z } }); 
                    } else mob.isAttacking = false;
                }
            } else if (mob.isGrounded) { 
                if(Math.random() < 0.05) mob.ry += (Math.random() - 0.5) * Math.PI;
                if(Math.random() < 0.2) { targetX = Math.sin(mob.ry) * mobSpeed * 0.02; targetZ = Math.cos(mob.ry) * mobSpeed * 0.02; mob.isMoving = true; } else mob.isMoving = false;
                mob.isAttacking = false; 
            }

            mob.x += targetX;
            if (checkCollisionServer(mob.x, mob.y, mob.z, room.seed, room.blocks)) {
                mob.x -= targetX; if (mob.isGrounded) { mob.vy = 8.5; mob.isGrounded = false; } 
            }
            mob.z += targetZ;
            if (checkCollisionServer(mob.x, mob.y, mob.z, room.seed, room.blocks)) {
                mob.z -= targetZ; if (mob.isGrounded) { mob.vy = 8.5; mob.isGrounded = false; } 
            }

            mob.vy -= 25.0 * 0.05; 
            let nextY = mob.y + (mob.vy * 0.05);
            
            if (checkCollisionServer(mob.x, nextY, mob.z, room.seed, room.blocks)) {
                if (mob.vy < 0) {
                    mob.y = Math.floor(nextY) + 1.0; 
                    mob.vy = 0; mob.isGrounded = true;
                } else {
                    mob.y = Math.floor(nextY + 1.8) - 1.8; 
                    mob.vy = 0; mob.isGrounded = false;
                }
            } else {
                mob.y = nextY;
                mob.isGrounded = false;
            }

            // ✨ FIX: Increased despawn distance so they don't vanish immediately
            if (minD > 60 || mob.y < -35) { 
                delete room.mobs[mobId]; 
                io.in(roomId).emit('mobDespawned', mobId); 
            }
        }
        io.in(roomId).emit('server_tick', { players: room.players, mobs: room.mobs });
    }
}, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Multiplayer Server running on port ${PORT}`));
