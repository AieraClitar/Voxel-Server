const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const DB_FILE = path.join(__dirname, 'saved_worlds.json');
let savedWorlds = {};

try {
    if (fs.existsSync(DB_FILE)) {
        savedWorlds = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        console.log("Database loaded successfully: " + Object.keys(savedWorlds).length + " worlds found.");
    }
} catch (err) {
    console.error("Failed to load database:", err);
}

function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(savedWorlds));
    } catch (err) {
        console.error("Failed to save database:", err);
    }
}

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

function getBlockAt(x, y, z, seed, customBlocks) {
    const bx = Math.floor(x); const by = Math.floor(y); const bz = Math.floor(z);
    const key = `${bx},${by},${bz}`;
    if (customBlocks[key]) return customBlocks[key];
    
    const noise = new SimpleNoise(seed); 
    const rough = new SimpleNoise(seed + 1337); 
    const trees = new SimpleNoise(seed + 888);
    const tempMap = new SimpleNoise(seed + 555);
    const humidMap = new SimpleNoise(seed + 999);
    
    let elevation = Math.floor((noise.getNoise(bx * 0.015, bz * 0.015) + 1) * 8 + rough.getNoise(bx * 0.06, bz * 0.06) * 3) + 2;
    let temp = tempMap.getNoise(bx * 0.005, bz * 0.005);
    let humid = humidMap.getNoise(bx * 0.005, bz * 0.005);
    let biome = 'plains'; if (temp > 0.2 && humid < 0) biome = 'desert'; else if (temp < -0.25) biome = 'tundra';

    let isCave = false;
    if (by <= elevation && by > -30) {
        let n1 = rough.getNoise(bx * 0.04, by * 0.04 + bz * 0.01); 
        let n2 = humidMap.getNoise(bz * 0.04, by * 0.04 + bx * 0.01); 
        if (Math.abs(n1) < 0.12 && Math.abs(n2) < 0.12) isCave = true;
    }

    if (isCave) {
        if (by <= -25) return 'lava';
        return 'air';
    }
    
    if (by > elevation) {
        if (by <= 5) return (biome === 'tundra' && by === 5) ? 'ice' : 'water';
        let isTundra = biome === 'tundra';
        if (!isTundra && by <= elevation + 5 && trees.getNoise(bx * 0.02, bz * 0.02) > 0.1 && Math.abs(trees.random(bx, bz)) < 0.03) return 'wood'; 
        return 'air'; 
    }

    if (by === elevation) {
        if (elevation < 5) return 'dirt'; 
        if (biome === 'desert') return 'sand';
        if (biome === 'tundra') return 'snow';
        return elevation <= 6 ? 'sand' : 'grass';
    }
    
    if (by > elevation - 3 && by !== -30) return biome === 'desert' ? 'sand' : 'dirt';
    return 'stone';
}

function checkCollisionServer(x, y, z, seed, customBlocks) {
    const radius = 0.25; const feetY = y; const headY = y + 1.7; 
    const pMinX = Math.floor(x - radius + 0.5); const pMaxX = Math.floor(x + radius + 0.5); 
    const pMinY = Math.floor(feetY + 0.5); const pMaxY = Math.floor(headY + 0.5); 
    const pMinZ = Math.floor(z - radius + 0.5); const pMaxZ = Math.floor(z + radius + 0.5);
    
    for (let bx = pMinX; bx <= pMaxX; bx++) {
        for (let by = pMinY; by <= pMaxY; by++) {
            for (let bz = pMinZ; bz <= pMaxZ; bz++) {
                const type = getBlockAt(bx, by, bz, seed, customBlocks);
                if (type !== 'air' && type !== 'water' && type !== 'lava' && type !== 'torch' && type !== 'leaves') {
                    if (feetY < by + 0.5 && headY > by - 0.5) return true;
                }
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

function getValidSpawnY(x, z, seed, customBlocks) {
    let validFloors = [];
    for (let y = -28; y <= 60; y++) {
        const type = getBlockAt(x, y, z, seed, customBlocks);
        if (type !== 'air' && type !== 'water' && type !== 'lava' && type !== 'torch' && type !== 'leaves' && type !== 'wood') {
            const blockAbove1 = getBlockAt(x, y + 1, z, seed, customBlocks);
            const blockAbove2 = getBlockAt(x, y + 2, z, seed, customBlocks);
            if ((blockAbove1 === 'air' || blockAbove1 === 'torch' || blockAbove1 === 'leaves') && 
                (blockAbove2 === 'air' || blockAbove2 === 'torch' || blockAbove2 === 'leaves')) {
                validFloors.push(y);
            }
        }
    }
    if (validFloors.length > 0) {
        if (Math.random() > 0.3) return validFloors[validFloors.length - 1]; 
        return validFloors[Math.floor(Math.random() * validFloors.length)]; 
    }
    return null;
}

const sessions = {}; 
let globalIdCounter = 0;

io.on('connection', (socket) => {
    const broadcastLobby = () => { 
        io.emit('lobbyUpdate', Object.keys(sessions).map(id => ({ 
            id: id, worldName: sessions[id].worldName, hostName: sessions[id].hostName, playerCount: Object.keys(sessions[id].players).length 
        }))); 
    };
    broadcastLobby();

    socket.on('requestSavedWorlds', () => {
        socket.emit('savedWorldsList', Object.keys(savedWorlds));
    });

    socket.on('createGame', (data) => {
        const wName = data.worldName || "New World";
        const passcode = data.passcode;
        let hostName = data.playerName || "Guest";

        let activeRoomId = null;
        for (let rid in sessions) {
            if (sessions[rid].worldName === wName) {
                activeRoomId = rid;
                break;
            }
        }

        if (activeRoomId) {
            if (sessions[activeRoomId].passcode !== passcode) {
                socket.emit('hostError', 'Incorrect Passcode for this active world!');
                return;
            }
            sessions[activeRoomId].hostId = socket.id; 
            joinRoom(socket, activeRoomId, hostName);
            broadcastLobby();
            return;
        }

        let seed = Math.floor(Math.random() * 10000);
        let blocks = {};
        let loadedPlayers = {};

        if (savedWorlds[wName]) {
            if (savedWorlds[wName].passcode !== passcode) {
                socket.emit('hostError', 'Incorrect Passcode for this saved world!');
                return;
            }
            seed = savedWorlds[wName].seed;
            blocks = JSON.parse(JSON.stringify(savedWorlds[wName].blocks));
            loadedPlayers = savedWorlds[wName].players || {};
            hostName = savedWorlds[wName].hostName; 
            delete savedWorlds[wName]; 
            saveDatabase();
        }

        const roomId = socket.id; 
        sessions[roomId] = { 
            seed: seed, 
            hostId: socket.id, 
            worldName: wName, 
            hostName: hostName, 
            passcode: passcode, 
            players: {}, blocks: blocks, drops: {}, mobs: {}, startTime: Date.now(), lastSpawnTime: 0,
            savedPlayers: loadedPlayers,
            fluidQueue: [], activeFluids: new Set()
        };
        joinRoom(socket, roomId, hostName); 
        broadcastLobby(); 
    });

    socket.on('joinGame', (data) => { 
        if(sessions[data.roomId]) { 
            let pName = data.playerName || "Guest";
            if (pName.toLowerCase() === sessions[data.roomId].hostName.toLowerCase()) {
                socket.emit('joinError', 'Access Denied: That name belongs to the Host. If you are the Host, please use the "Host World" menu and enter your Passcode to reclaim your world.');
                return;
            }
            joinRoom(socket, data.roomId, pName); 
            broadcastLobby(); 
        } else {
            socket.emit('joinError', 'This world no longer exists or the host has left.');
        }
    });

    function joinRoom(socket, roomId, playerName) {
        socket.join(roomId); socket.roomId = roomId; const room = sessions[roomId];
        
        let px = 16, pz = 16;
        let py = getValidSpawnY(px, pz, room.seed, room.blocks) || 60;
        py += 2; // Spawn 2 blocks above the floor to prevent clipping
        let pHealth = 100;
        let hasSavedData = false;
        let savedInv = null;

        if (room.savedPlayers && room.savedPlayers[playerName]) {
            const sp = room.savedPlayers[playerName];
            px = sp.x; py = sp.y; pz = sp.z; pHealth = sp.health;
            savedInv = sp.inventory;
            hasSavedData = true;
        }

        room.players[socket.id] = { name: playerName, x: px, y: py, z: pz, ry: 0, rx: 0, heldItem: null, isAttacking: false, health: pHealth };
        
        socket.emit('world_snapshot', { seed: room.seed, players: room.players, blocks: room.blocks, drops: room.drops, mobs: room.mobs, ageInSeconds: (Date.now() - room.startTime) / 1000, isHost: socket.id === room.hostId });
        
        if (hasSavedData) {
            socket.emit('restore_player_data', { inventory: savedInv, x: px, y: py, z: pz, health: pHealth });
        }

        socket.to(roomId).emit('newPlayer', { id: socket.id, player: room.players[socket.id] });
    }

    socket.on('saveAndExit', (data) => {
        const room = sessions[socket.roomId];
        if (!room) return;

        room.savedPlayers[data.playerName] = {
            inventory: data.inventory, x: data.x, y: data.y, z: data.z, health: data.health
        };

        if (room.hostId === socket.id) {
            const wName = room.worldName;
            if (!savedWorlds[wName]) savedWorlds[wName] = { seed: room.seed, blocks: {}, players: {} };
            savedWorlds[wName].passcode = room.passcode;
            savedWorlds[wName].hostName = room.hostName;
            savedWorlds[wName].blocks = JSON.parse(JSON.stringify(room.blocks));
            savedWorlds[wName].players = room.savedPlayers; 
            saveDatabase();
        }

        // ✨ THE FIX: We must broadcast the player disconnected signal explicitly BEFORE disconnecting the socket.
        socket.to(socket.roomId).emit('playerDisconnected', socket.id);
        delete room.players[socket.id];

        socket.emit('hostLeft', 'Progress saved! You have safely exited the world.');
        socket.disconnect(); 
    });

    socket.on('move', (data) => { if(socket.roomId && sessions[socket.roomId] && sessions[socket.roomId].players[socket.id]) { Object.assign(sessions[socket.roomId].players[socket.id], data); socket.broadcast.to(socket.roomId).emit('playerMoved', { id: socket.id, ...data }); } });
    socket.on('requestBlockBreak', (data) => { 
        const room = sessions[socket.roomId]; if (!room) return; 
        const key = `${Math.floor(data.x)},${Math.floor(data.y)},${Math.floor(data.z)}`; 
        const actualType = room.blocks[key] || data.type; if (actualType === 'air') return; 
        room.blocks[key] = 'air'; 
        
        // Fluid flow update around broken block
        const offsets = [[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];
        offsets.forEach(off => {
            const tx = Math.floor(data.x)+off[0], ty = Math.floor(data.y)+off[1], tz = Math.floor(data.z)+off[2];
            const tKey = `${tx},${ty},${tz}`;
            if (room.blocks[tKey] === 'water' || room.blocks[tKey] === 'lava') room.activeFluids.add(tKey);
        });

        io.in(socket.roomId).emit('blockUpdate', { action: 'remove', x: data.x, y: data.y, z: data.z, type: actualType }); 
        const dropId = 'drop_' + globalIdCounter++; const dropData = { id: dropId, x: data.x, y: data.y, z: data.z, type: actualType }; room.drops[dropId] = dropData; io.in(socket.roomId).emit('item_spawned', dropData); 
    });
    
    socket.on('requestBlockPlace', (data) => { 
        const room = sessions[socket.roomId]; if (!room) return; 
        const key = `${Math.floor(data.x)},${Math.floor(data.y)},${Math.floor(data.z)}`; 
        room.blocks[key] = data.type; 
        if (data.type === 'water' || data.type === 'lava') room.activeFluids.add(key);
        io.in(socket.roomId).emit('blockUpdate', { action: 'add', x: data.x, y: data.y, z: data.z, type: data.type }); 
    });
    
    socket.on('requestDropItem', (data) => { const room = sessions[socket.roomId]; if (!room) return; const dropId = 'drop_' + globalIdCounter++; const dropData = { id: dropId, ...data }; room.drops[dropId] = room.drops[dropId] || dropData; io.in(socket.roomId).emit('item_spawned', dropData); });
    socket.on('requestPickup', (dropId) => { const room = sessions[socket.roomId]; if(room && room.drops[dropId]) { const itemType = room.drops[dropId].type; delete room.drops[dropId]; socket.emit('pickupSuccess', itemType); io.in(socket.roomId).emit('item_removed', dropId); } });
    
    socket.on('requestPlayerDamage', (data) => { 
        const room = sessions[socket.roomId]; 
        if (room && room.players[socket.id]) { 
            room.players[socket.id].health -= data.dmg; 
            io.in(socket.roomId).emit('playerDamaged', { id: socket.id, dmg: data.dmg, source: data.source }); 
            if (room.players[socket.id].health <= 0) {
                const playerName = room.players[socket.id].name;
                const deathMsg = `💀 ${playerName} was slain by a ${data.source.toUpperCase()}!`;
                io.in(socket.roomId).emit('mobKilled', { mobId: 'none', killerName: deathMsg, mobType: '' });
            }
        } 
    });
    
    socket.on('requestMobAttack', (data) => {
        const room = sessions[socket.roomId];
        if (room && room.mobs[data.id]) {
            room.mobs[data.id].health -= data.dmg; io.in(socket.roomId).emit('mobDamaged', { id: data.id, kbDir: data.kbDir });
            
            if (room.mobs[data.id].health <= 0) { 
                const mobType = room.mobs[data.id].type.toUpperCase(); 
                delete room.mobs[data.id]; 
                const killerMsg = `⚔️ ${room.players[socket.id].name} slaughtered a ${mobType}!`;
                io.in(socket.roomId).emit('mobKilled', { mobId: data.id, killerName: killerMsg, mobType: mobType }); 
            }
        }
    });

    socket.on('playerRespawn', () => { if(socket.roomId && sessions[socket.roomId] && sessions[socket.roomId].players[socket.id]) sessions[socket.roomId].players[socket.id].health = 100; });
    
    socket.on('disconnect', () => { 
        if(socket.roomId && sessions[socket.roomId]) { 
            const room = sessions[socket.roomId];
            
            if (room.players[socket.id]) {
                const pName = room.players[socket.id].name;
                if (!room.savedPlayers[pName]) room.savedPlayers[pName] = { inventory: null };
                room.savedPlayers[pName].x = room.players[socket.id].x;
                room.savedPlayers[pName].y = room.players[socket.id].y;
                room.savedPlayers[pName].z = room.players[socket.id].z;
                room.savedPlayers[pName].health = room.players[socket.id].health;
            }

            delete room.players[socket.id]; 
            socket.to(socket.roomId).emit('playerDisconnected', socket.id); 
            
            if(Object.keys(room.players).length === 0) { 
                const wName = room.worldName;
                if (!savedWorlds[wName]) savedWorlds[wName] = { seed: room.seed, blocks: {}, players: {} };
                savedWorlds[wName].passcode = room.passcode;
                savedWorlds[wName].hostName = room.hostName;
                savedWorlds[wName].blocks = JSON.parse(JSON.stringify(room.blocks));
                savedWorlds[wName].players = room.savedPlayers; 

                delete sessions[socket.roomId]; 
                saveDatabase();
            } 
            broadcastLobby(); 
        } 
    });
});

setInterval(() => {
    const now = Date.now();
    for (let roomId in sessions) {
        const room = sessions[roomId]; const playerIds = Object.keys(room.players); if (playerIds.length === 0) continue;
        const dayTime = ((now - room.startTime) / 1000 / 240.0) % 1; const isDay = Math.sin(dayTime * Math.PI * 2) > 0.1;

        let currentZombies = 0; let currentArchers = 0;
        for (let m in room.mobs) {
            if (room.mobs[m].type === 'zombie') currentZombies++;
            else if (room.mobs[m].type === 'archer') currentArchers++;
        }

        if (Object.keys(room.mobs).length < 25 && (now - room.lastSpawnTime > 1000)) {
            const spawnChance = isDay ? 0.05 : 0.4; 
            
            if (Math.random() < spawnChance) {
                const targetPlayer = room.players[playerIds[Math.floor(Math.random() * playerIds.length)]];
                const angle = Math.random() * Math.PI * 2; 
                const dist = 15 + Math.random() * 15; 
                const mx = targetPlayer.x + Math.cos(angle) * dist; 
                const mz = targetPlayer.z + Math.sin(angle) * dist;
                
                const floorY = getValidSpawnY(mx, mz, room.seed, room.blocks);

                if (floorY !== null) { 
                    const id = 'mob_' + globalIdCounter++; 
                    let isZombie;
                    if (isDay) { isZombie = true; } else { if (currentArchers < 6) { isZombie = Math.random() > 0.35; } else { isZombie = true; } }

                    const zombieWeapons = ['none', 'wooden_sword', 'stone_sword', 'wooden_axe', 'stone_pickaxe', 'wooden_shovel'];
                    const archerWeapons = ['bow', 'crossbow', 'gun'];
                    const weapon = isZombie ? zombieWeapons[Math.floor(Math.random() * zombieWeapons.length)] : archerWeapons[Math.floor(Math.random() * archerWeapons.length)];
                    const zombieFaces = ['zombie_face', 'zombie_face_var1', 'zombie_face_var2'];
                    const faceType = isZombie ? zombieFaces[Math.floor(Math.random() * zombieFaces.length)] : (weapon === 'gun' ? 'archer_face_gun' : (weapon === 'crossbow' ? 'archer_face_crossbow' : 'archer_face_bow'));

                    room.mobs[id] = { 
                        id: id, type: isZombie ? 'zombie' : 'archer', weapon: weapon, face: faceType, 
                        x: mx, y: floorY + 0.5, z: mz, vy: 0, ry: 0, rx: 0, health: 100, isMoving: false, isAttacking: false, isBurning: false, attackTimer: 0, isGrounded: false, roamTimer: 0
                    };
                    room.lastSpawnTime = now; io.in(roomId).emit('mobSpawned', room.mobs[id]);
                }
            }
        }

        for (let mobId in room.mobs) {
            let mob = room.mobs[mobId]; let closestPlayer = null; let minD = 9999;
            for (let pid in room.players) {
                let p = room.players[pid]; 
                if (p.health <= 0) continue; 
                let d = Math.sqrt(Math.pow(p.x - mob.x, 2) + Math.pow(p.y - mob.y, 2) + Math.pow(p.z - mob.z, 2));
                if (d < minD) { minD = d; closestPlayer = {id: pid, ...p}; }
            }

            if (mob.attackTimer > 0) mob.attackTimer -= 0.05; 
            const mobSpeed = mob.type === 'zombie' ? 2.5 : 2.0; 

            mob.isBurning = false; let hasRoof = false;
            
            for(let ty = Math.floor(mob.y) + 2; ty < Math.floor(mob.y) + 30; ty++) { 
                if(getBlockAt(mob.x, ty, mob.z, room.seed, room.blocks) !== 'air') { hasRoof = true; break; } 
            }
            
            if (mob.type === 'zombie' && isDay && !hasRoof) {
                mob.isBurning = true; 
                if (Math.random() < 0.1) {
                    mob.health -= 5; io.in(roomId).emit('mobDamaged', { id: mob.id, kbDir: {x:0, y:0, z:0} });
                    if (mob.health <= 0) { delete room.mobs[mobId]; io.in(roomId).emit('mobDespawned', mobId); continue; }
                }
            }
            
            let inWater = getBlockAt(mob.x, mob.y, mob.z, room.seed, room.blocks) === 'water';
            let inLava = getBlockAt(mob.x, mob.y, mob.z, room.seed, room.blocks) === 'lava';

            if (inLava) {
                mob.isBurning = true;
                if (Math.random() < 0.2) {
                    mob.health -= 15; io.in(roomId).emit('mobDamaged', { id: mob.id, kbDir: {x:0, y:0, z:0} });
                    if (mob.health <= 0) { delete room.mobs[mobId]; io.in(roomId).emit('mobDespawned', mobId); continue; }
                }
            }

            let targetX = 0, targetZ = 0;
            let los = closestPlayer ? hasLineOfSight(mob.x, mob.y + 1.5, mob.z, closestPlayer.x, closestPlayer.y + 1.5, closestPlayer.z, room.seed, room.blocks) : false;

            if (mob.isBurning && !closestPlayer) {
                if (!mob.roamTimer || mob.roamTimer <= 0) { mob.ry = Math.random() * Math.PI * 2; mob.roamTimer = 20; }
                mob.roamTimer--; targetX = Math.sin(mob.ry) * mobSpeed * 0.06; targetZ = Math.cos(mob.ry) * mobSpeed * 0.06; mob.isMoving = true;
            } else if (closestPlayer && minD < 20 && los) {
                const angle = Math.atan2(closestPlayer.x - mob.x, closestPlayer.z - mob.z); mob.ry = angle;
                
                if (mob.type === 'zombie') {
                    if (minD > 1.8) { 
                        targetX = Math.sin(angle) * mobSpeed * 0.05; targetZ = Math.cos(angle) * mobSpeed * 0.05; mob.isMoving = true; mob.isAttacking = false; 
                    } else {
                        mob.isMoving = false;
                        if (mob.attackTimer <= 0) { 
                            mob.attackTimer = 1.5; mob.isAttacking = true; 
                            let dmg = 10; if(mob.weapon.includes('sword')) dmg = 25; else if(mob.weapon.includes('axe')) dmg = 20; else if(mob.weapon !== 'none') dmg = 15;
                            room.players[closestPlayer.id].health -= dmg; 
                            io.in(roomId).emit('playerDamaged', { id: closestPlayer.id, dmg: dmg, source: 'Zombie' }); 
                            
                            if (room.players[closestPlayer.id].health <= 0) {
                                io.in(roomId).emit('mobKilled', { mobId: 'none', killerName: `💀 ${room.players[closestPlayer.id].name} was mauled by a ZOMBIE!`, mobType: '' });
                            }
                        } else mob.isAttacking = false;
                    }
                } else if (mob.type === 'archer') {
                    if (minD > 12.0) { 
                        targetX = Math.sin(angle) * mobSpeed * 0.05; targetZ = Math.cos(angle) * mobSpeed * 0.05; mob.isMoving = true; mob.isAttacking = false; 
                    } else if (minD < 6.0) { 
                        targetX = -Math.sin(angle) * mobSpeed * 0.05; targetZ = -Math.cos(angle) * mobSpeed * 0.05; mob.isMoving = true; mob.isAttacking = false; 
                    } else { 
                        mob.isMoving = false; 
                    }
                    
                    if (minD <= 20.0 && mob.attackTimer <= 0 && los) { 
                        mob.attackTimer = mob.weapon === 'gun' ? 1.5 : 3.0; mob.isAttacking = true; 
                        io.in(roomId).emit('mobShoot', { type: mob.weapon, from: { x: mob.x, y: mob.y + 1.2, z: mob.z }, to: { x: closestPlayer.x, y: closestPlayer.y + 1.5, z: closestPlayer.z } }); 
                    } else mob.isAttacking = false;
                }
            } else if (mob.isGrounded) { 
                if (!mob.roamTimer || mob.roamTimer <= 0) {
                    mob.roamTimer = 20 + Math.floor(Math.random() * 40); mob.isMoving = Math.random() < 0.6; 
                    if (mob.isMoving) mob.ry += (Math.random() - 0.5) * Math.PI;
                }
                mob.roamTimer--;
                if (mob.isMoving) { targetX = Math.sin(mob.ry) * mobSpeed * 0.02; targetZ = Math.cos(mob.ry) * mobSpeed * 0.02; } else { targetX = 0; targetZ = 0; }
                mob.isAttacking = false; 
            }

            mob.x += targetX;
            if (checkCollisionServer(mob.x, mob.y, mob.z, room.seed, room.blocks)) {
                mob.x -= targetX; 
                if (mob.isGrounded && mob.isMoving) {
                    if (!checkCollisionServer(mob.x + targetX, mob.y + 1.5, mob.z, room.seed, room.blocks)) {
                        mob.vy = 8.5; mob.isGrounded = false;
                    }
                }
            }
            
            mob.z += targetZ;
            if (checkCollisionServer(mob.x, mob.y, mob.z, room.seed, room.blocks)) {
                mob.z -= targetZ; 
                if (mob.isGrounded && mob.isMoving) {
                    if (!checkCollisionServer(mob.x, mob.y + 1.5, mob.z + targetZ, room.seed, room.blocks)) {
                        mob.vy = 8.5; mob.isGrounded = false;
                    }
                }
            }

            if (inWater || inLava) { mob.vy = 2.0; } else { mob.vy -= 25.0 * 0.05; }

            let yMove = mob.vy * 0.05;
            let ySteps = Math.max(1, Math.ceil(Math.abs(yMove) / 0.1)); 
            let yStepAmt = yMove / ySteps;

            for (let i = 0; i < ySteps; i++) {
                mob.y += yStepAmt;
                if (mob.vy < 0) { 
                    if (checkCollisionServer(mob.x, mob.y, mob.z, room.seed, room.blocks)) { 
                        mob.y -= yStepAmt; mob.y = Math.floor(mob.y - 0.001) + 0.5; mob.vy = 0; mob.isGrounded = true; break; 
                    } else { mob.isGrounded = false; } 
                } else if (mob.vy > 0) { 
                    if (checkCollisionServer(mob.x, mob.y, mob.z, room.seed, room.blocks)) { mob.y -= yStepAmt; mob.vy = 0; break; } 
                }
            }

            let nearestDistToAnyPlayer = 9999;
            for (let pid in room.players) {
                let p = room.players[pid];
                let d = Math.sqrt(Math.pow(p.x - mob.x, 2) + Math.pow(p.y - mob.y, 2) + Math.pow(p.z - mob.z, 2));
                if (d < nearestDistToAnyPlayer) nearestDistToAnyPlayer = d;
            }

            if (nearestDistToAnyPlayer > 60 || mob.y < -35) { 
                delete room.mobs[mobId]; io.in(roomId).emit('mobDespawned', mobId); 
            }
        }
        
        for (let pid in room.players) {
            let p = room.players[pid];
            if (p.health <= 0) continue;
            if (getBlockAt(p.x, p.y - 1.5, p.z, room.seed, room.blocks) === 'lava' || getBlockAt(p.x, p.y, p.z, room.seed, room.blocks) === 'lava') {
                if (Math.random() < 0.1) {
                    p.health -= 10;
                    io.in(roomId).emit('playerDamaged', { id: pid, dmg: 10, source: 'Lava' });
                    if (p.health <= 0) {
                        io.in(roomId).emit('mobKilled', { mobId: 'none', killerName: `🔥 ${p.name} burned to death in LAVA!`, mobType: '' });
                    }
                }
            }
        }

        io.in(roomId).emit('server_tick', { players: room.players, mobs: room.mobs });
    }
}, 50);

setInterval(() => {
    for (let roomId in sessions) {
        const room = sessions[roomId];
        if (room.activeFluids && room.activeFluids.size > 0) {
            let nextFluids = new Set();
            for (let fKey of room.activeFluids) {
                const [fx, fy, fz] = fKey.split(',').map(Number);
                const type = room.blocks[fKey];
                if (type !== 'water' && type !== 'lava') continue;
                
                const dKey = `${fx},${fy-1},${fz}`;
                const dType = getBlockAt(fx, fy-1, fz, room.seed, room.blocks);
                if (dType === 'air') {
                    room.blocks[dKey] = type; nextFluids.add(dKey);
                    io.in(roomId).emit('blockUpdate', { action: 'add', x: fx, y: fy-1, z: fz, type: type });
                } else if (dType !== 'water' && dType !== 'lava') {
                    const sides = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];
                    for (let s of sides) {
                        const sKey = `${fx+s[0]},${fy},${fz+s[2]}`;
                        if (getBlockAt(fx+s[0], fy, fz+s[2], room.seed, room.blocks) === 'air') {
                            room.blocks[sKey] = type; nextFluids.add(sKey);
                            io.in(roomId).emit('blockUpdate', { action: 'add', x: fx+s[0], y: fy, z: fz+s[2], type: type });
                        }
                    }
                }
            }
            room.activeFluids = nextFluids;
        }
    }
}, 500);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Multiplayer Server running on port ${PORT}`));
