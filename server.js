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

const players = {};

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    // Wait for the player to click "Play" and send their name
    socket.on('joinGame', (playerName) => {
        // Save their name along with their spawn position
        players[socket.id] = { 
            name: playerName || "Guest", 
            x: 16, y: 30, z: 16, ry: 0, rx: 0 
        };

        // Send them the current world state
        socket.emit('currentPlayers', players);
        
        // Tell everyone else a new player joined (now includes name)
        socket.broadcast.emit('newPlayer', { id: socket.id, player: players[socket.id] });
    });

    // Listen for movement and broadcast to others
    socket.on('move', (data) => {
        if(players[socket.id]) {
            players[socket.id] = data;
            socket.broadcast.emit('playerMoved', { id: socket.id, ...data });
        }
    });

    // Listen for block changes and echo to all clients
    socket.on('blockUpdate', (data) => {
        socket.broadcast.emit('blockUpdate', data);
    });

    // Clean up when someone leaves
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        delete players[socket.id];
        socket.broadcast.emit('playerDisconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Multiplayer Server running on port ${PORT}`);
});
