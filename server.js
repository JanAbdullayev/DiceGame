const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

// --- RAILWAY PERSISTENCE & DB SETUP ---
// We check if the '/data' folder exists (Railway uses this). 
// If not, we use the local folder (for when you run it on your laptop).
const dbDir = '/data';
const dbPath = fs.existsSync(dbDir) ? path.join(dbDir, 'dice_pot.db') : './dice_pot.db';
const db = new sqlite3.Database(dbPath);

console.log(`Database stored at: ${dbPath}`);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT UNIQUE, 
        password TEXT, 
        balance INTEGER DEFAULT 1000000
    )`);
});

app.use(express.static(__dirname));

// --- GLOBAL STATE ---
let lobbies = {}; 
const nickRegex = /^[A-Z][a-z]+_[A-Z][a-z]+$/;

// --- UTILS ---
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

io.on('connection', (socket) => {
    
    // --- AUTHENTICATION ---
    socket.on('auth', async (data) => {
        const { nickname, password } = data;
        if (!nickRegex.test(nickname)) return socket.emit('error_msg', 'Format: Name_Surname');

        db.get("SELECT * FROM users WHERE nickname = ?", [nickname], async (err, user) => {
            if (user) {
                if (await bcrypt.compare(password, user.password)) loginUser(socket, user);
                else socket.emit('error_msg', 'Wrong password!');
            } else {
                const hash = await bcrypt.hash(password, 10);
                db.run("INSERT INTO users (nickname, password) VALUES (?, ?)", [nickname, hash], function(err) {
                    if(err) return socket.emit('error_msg', 'Nickname taken');
                    loginUser(socket, {id: this.lastID, nickname, balance: 1000000});
                });
            }
        });
    });

    function loginUser(socket, userData) {
        socket.userData = { id: userData.id, nickname: userData.nickname, balance: userData.balance };
        socket.emit('auth_success', socket.userData);
        sendLobbyList(socket);
    }

    // --- LOBBY MANAGEMENT ---
    function sendLobbyList(target = io) {
        const list = Object.values(lobbies).map(l => ({ 
            id: l.id, name: l.name, users: l.users.length, host: l.roomHostName 
        }));
        target.emit('lobby_list', list);
    }

    socket.on('get_lobbies', () => sendLobbyList(socket));

    socket.on('create_lobby', (name) => {
        if (!socket.userData) return;
        const id = "room_" + Math.random().toString(36).substr(2, 5);
        
        lobbies[id] = {
            id, 
            name: name || `${socket.userData.nickname}'s Room`, 
            roomHostId: socket.id, 
            roomHostName: socket.userData.nickname,
            tableHostId: null, // Initial State: No table host
            lastWinnerId: null, // Track winner for highlighting
            
            // Game State
            state: 'IDLE', // IDLE, BETTING, PLAYING, FINISHED
            bet: 0,
            pot: 0,
            users: [], // Everyone in room
            players: [], // People seated at table
            turnOrder: [],
            turnIndex: 0,
            timer: null
        };
        joinLobby(socket, id);
    });

    socket.on('join_lobby', (id) => joinLobby(socket, id));
    
    // BINDING BET LOGIC: Prevent leaving via button if seated
    socket.on('leave_lobby', () => {
        const lobby = lobbies[socket.currentLobby];
        if (lobby && lobby.players.find(p => p.id === socket.id)) {
            return socket.emit('error_msg', 'You cannot leave while seated at the table!');
        }
        leaveLobby(socket);
    });

    function joinLobby(socket, id) {
        const lobby = lobbies[id];
        if (!lobby) return socket.emit('error_msg', 'Lobby not found');
        if (socket.currentLobby) leaveLobby(socket);

        socket.join(id);
        socket.currentLobby = id;
        lobby.users.push({ id: socket.id, nickname: socket.userData.nickname });
        
        // If room is leaderless, assign
        if (!lobby.users.find(u => u.id === lobby.roomHostId)) {
            lobby.roomHostId = socket.id;
            lobby.roomHostName = socket.userData.nickname;
        }

        socket.emit('joined_lobby', { lobby });
        io.to(id).emit('update_room', packLobbyData(lobby));
        sendLobbyList(); 
    }

    function packLobbyData(lobby) {
        return {
            id: lobby.id, 
            roomHostId: lobby.roomHostId, 
            tableHostId: lobby.tableHostId,
            lastWinnerId: lobby.lastWinnerId,
            state: lobby.state, 
            bet: lobby.bet, 
            pot: lobby.pot, 
            users: lobby.users,
            players: lobby.players, 
            currentTurn: (lobby.state === 'PLAYING') ? lobby.turnOrder[lobby.turnIndex] : null
        };
    }

    // --- GAME LOGIC ---

    // 1. Create Table / Set Bet
    socket.on('host_set_bet', (amount) => {
        const lobby = lobbies[socket.currentLobby];
        if (!lobby) return;

        // Validation
        if (lobby.state === 'PLAYING') return socket.emit('error_msg', 'Game in progress');
        if (lobby.tableHostId && lobby.tableHostId !== socket.id && lobby.state !== 'IDLE' && lobby.state !== 'FINISHED') {
             return socket.emit('error_msg', 'Table occupied');
        }

        amount = parseInt(amount);
        if (isNaN(amount) || amount <= 0) return socket.emit('error_msg', 'Invalid bet');

        // Logic: Reset table
        lobby.bet = amount;
        lobby.state = 'BETTING';
        lobby.tableHostId = socket.id;
        lobby.players = [];
        lobby.pot = 0;
        lobby.lastWinnerId = null; // Clear previous winner

        // Automatically sit the creator
        sitAtTable(socket, lobby);
        io.to(lobby.id).emit('chat_msg', { nick: 'SYSTEM', text: `Table opened! Bet: ${amount} ₽` });
    });

    // 2. Join Table
    socket.on('join_table', () => {
        const lobby = lobbies[socket.currentLobby];
        if (!lobby || lobby.state !== 'BETTING') return;
        sitAtTable(socket, lobby);
    });

    function sitAtTable(socket, lobby) {
        if (lobby.players.find(p => p.id === socket.id)) return;
        if (socket.userData.balance < lobby.bet) return socket.emit('error_msg', 'Insufficient funds');

        // Deduct Money
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [lobby.bet, socket.userData.id], (err) => {
            if (err) return;
            
            socket.userData.balance -= lobby.bet;
            // Send only balance update so we don't trigger "auth_success" redirection
            socket.emit('balance_update', socket.userData.balance); 

            lobby.pot += lobby.bet;
            lobby.players.push({ 
                id: socket.id, 
                nickname: socket.userData.nickname, 
                lastRoll: null 
            });

            // Update everyone
            io.to(lobby.id).emit('update_room', packLobbyData(lobby));
            io.to(lobby.id).emit('chat_msg', { nick: 'SYSTEM', text: `${socket.userData.nickname} joined the table.` });
        });
    }

    // 3. Start Game
    socket.on('start_game', () => {
        const lobby = lobbies[socket.currentLobby];
        if (!lobby || lobby.tableHostId !== socket.id || lobby.state !== 'BETTING') return;
        
        if (lobby.players.length < 2) return socket.emit('error_msg', 'Need at least 2 players');

        startGame(lobby, lobby.players);
    });

    function startGame(lobby, participants) {
        lobby.state = 'PLAYING';
        // Randomize turns
        lobby.turnOrder = shuffle(participants.map(p => p.id));
        lobby.turnIndex = 0;
        lobby.lastWinnerId = null;
        
        // Reset rolls
        lobby.players.forEach(p => { if(lobby.turnOrder.includes(p.id)) p.lastRoll = null; });

        io.to(lobby.id).emit('update_room', packLobbyData(lobby));
        io.to(lobby.id).emit('chat_msg', { nick: 'SYSTEM', text: `Game Started! Pot: ${lobby.pot} ₽` });
        processTurn(lobby);
    }

    function processTurn(lobby) {
        const playerId = lobby.turnOrder[lobby.turnIndex];
        const player = lobby.players.find(p => p.id === playerId);
        
        if (!player) return;

        io.to(lobby.id).emit('turn_notification', { playerId, nickname: player.nickname });

        // 10s Timer
        if (lobby.timer) clearTimeout(lobby.timer);
        lobby.timer = setTimeout(() => {
            performRoll(lobby, player, true); // Auto-roll
        }, 10000);
    }

    // 4. Roll Dice
    socket.on('roll_dice', () => {
        const lobby = lobbies[socket.currentLobby];
        if (!lobby || lobby.state !== 'PLAYING') return;
        
        const currentTurnId = lobby.turnOrder[lobby.turnIndex];
        if (socket.id !== currentTurnId) return;

        const player = lobby.players.find(p => p.id === socket.id);
        performRoll(lobby, player, false);
    });

    function performRoll(lobby, player, isAuto) {
        if (lobby.timer) clearTimeout(lobby.timer);

        const d1 = getRandomInt(1, 6);
        const d2 = getRandomInt(1, 6);
        player.lastRoll = d1 + d2; 

        // 1. Send numbers for animation immediately
        io.to(lobby.id).emit('dice_rolled', { playerId: player.id, d1, d2, sum: player.lastRoll });
        
        // 2. Wait 1.5s (animation length) before updating Chat and Player List
        setTimeout(() => {
             // Chat Message
            io.to(lobby.id).emit('chat_msg', { 
                nick: 'GAME', 
                text: `${player.nickname} rolled ${player.lastRoll} (${d1} + ${d2})` 
            });
            
            // Reveal Number in List
            io.to(lobby.id).emit('update_room', packLobbyData(lobby));

        }, 1500);

        // 3. Move to next turn after enough time to read (3.5s total)
        setTimeout(() => {
            lobby.turnIndex++;
            if (lobby.turnIndex >= lobby.turnOrder.length) {
                determineWinner(lobby);
            } else {
                processTurn(lobby);
            }
        }, 3500);
    }

    function determineWinner(lobby) {
        const participants = lobby.players.filter(p => lobby.turnOrder.includes(p.id));
        let highest = -1;
        participants.forEach(p => { if (p.lastRoll > highest) highest = p.lastRoll; });

        const winners = participants.filter(p => p.lastRoll === highest);

        if (winners.length === 1) {
            // WINNER FOUND
            const winner = winners[0];
            const winAmount = lobby.pot;
            lobby.lastWinnerId = winner.id; // Mark winner for UI
            
            // DB Update
            db.run("UPDATE users SET balance = balance + ? WHERE nickname = ?", [winAmount, winner.nickname], () => {
                const s = io.sockets.sockets.get(winner.id);
                if(s) {
                    s.userData.balance += winAmount;
                    s.emit('balance_update', s.userData.balance); 
                }
            });

            io.to(lobby.id).emit('game_over', { winner: winner.nickname, pot: winAmount });
            io.to(lobby.id).emit('chat_msg', { nick: '🏆', text: `${winner.nickname} WON ${winAmount} ₽!` });
            
            // CLEANUP
            lobby.state = 'FINISHED';
            // Keep Host AND Winner at the table
            lobby.players = lobby.players.filter(p => p.id === lobby.tableHostId || p.id === winner.id);
            lobby.pot = 0;
            
            io.to(lobby.id).emit('update_room', packLobbyData(lobby));

        } else {
            // TIE -> SUDDEN DEATH
            io.to(lobby.id).emit('chat_msg', { nick: 'SYSTEM', text: `TIE! Round 2 starting...` });
            startGame(lobby, winners);
        }
    }

    // --- LEAVE LOGIC ---
    function leaveLobby(socket) {
        const id = socket.currentLobby;
        if (!id) return;

        const lobby = lobbies[id];
        if (lobby) {
            lobby.users = lobby.users.filter(u => u.id !== socket.id);
            lobby.players = lobby.players.filter(p => p.id !== socket.id);

            if (lobby.roomHostId === socket.id && lobby.users.length > 0) {
                lobby.roomHostId = lobby.users[0].id;
                lobby.roomHostName = lobby.users[0].nickname;
            }

            if (lobby.tableHostId === socket.id) {
                if (lobby.players.length > 0) {
                    lobby.tableHostId = lobby.players[0].id;
                } else if (lobby.users.length > 0) {
                    lobby.tableHostId = null;
                    lobby.state = 'IDLE';
                    lobby.bet = 0;
                }
            }
            
            if (lobby.users.length === 0) delete lobbies[id];
            else io.to(id).emit('update_room', packLobbyData(lobby));
        }

        socket.leave(id);
        socket.currentLobby = null;
        socket.emit('left_lobby_success');
        sendLobbyList();
    }

    socket.on('send_msg', (t) => {
        if (socket.currentLobby && t.trim()) {
            io.to(socket.currentLobby).emit('chat_msg', { nick: socket.userData.nickname, text: t });
        }
    });

    socket.on('disconnect', () => leaveLobby(socket));
});

// RAILWAY PORT LOGIC
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));