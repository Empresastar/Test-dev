// Arena Showdown - Servidor de Sinalização WebRTC
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Criar servidor HTTP
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Erro ao carregar página');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Não encontrado');
    }
});

// Criar servidor WebSocket
const wss = new WebSocket.Server({ server });

// Salas ativas: roomCode -> {host: ws, guest: ws, hostReady: bool, guestReady: bool}
const rooms = new Map();

// Mapear conexões para salas: ws -> roomCode
const wsToRoom = new Map();

function broadcast(room, message, exclude = null) {
    const roomData = rooms.get(room);
    if (!roomData) return;
    
    [roomData.host, roomData.guest].forEach(client => {
        if (client && client !== exclude && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

function sendTo(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

wss.on('connection', (ws) => {
    console.log('Nova conexão estabelecida');

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            switch (msg.type) {
                case 'create_room':
                    // Host cria sala
                    if (rooms.has(msg.roomCode)) {
                        sendTo(ws, { type: 'error', message: 'Sala já existe' });
                        return;
                    }
                    rooms.set(msg.roomCode, {
                        host: ws,
                        guest: null,
                        hostReady: false,
                        guestReady: false,
                        tema: msg.tema || '',
                        startTime: null
                    });
                    wsToRoom.set(ws, msg.roomCode);
                    sendTo(ws, { type: 'room_created', roomCode: msg.roomCode, role: 'host' });
                    console.log(`Sala ${msg.roomCode} criada`);
                    break;

                case 'join_room':
                    // Guest entra na sala
                    const room = rooms.get(msg.roomCode);
                    if (!room) {
                        sendTo(ws, { type: 'error', message: 'Sala não encontrada' });
                        return;
                    }
                    if (room.guest) {
                        sendTo(ws, { type: 'error', message: 'Sala cheia' });
                        return;
                    }
                    
                    room.guest = ws;
                    wsToRoom.set(ws, msg.roomCode);
                    
                    // Notificar guest
                    sendTo(ws, { type: 'room_joined', roomCode: msg.roomCode, role: 'guest', tema: room.tema });
                    
                    // Notificar host
                    sendTo(room.host, { type: 'opponent_joined' });
                    
                    console.log(`Guest entrou na sala ${msg.roomCode}`);
                    break;

                case 'start_game':
                    // Host inicia o jogo
                    const startRoom = rooms.get(msg.roomCode);
                    if (!startRoom || startRoom.host !== ws) return;
                    
                    startRoom.tema = msg.tema;
                    startRoom.startTime = Date.now();
                    
                    broadcast(msg.roomCode, {
                        type: 'game_started',
                        tema: msg.tema,
                        timestamp: startRoom.startTime
                    });
                    console.log(`Jogo iniciado na sala ${msg.roomCode}: ${msg.tema}`);
                    break;

                case 'ready':
                    // Jogador marca como pronto
                    const readyRoom = rooms.get(msg.roomCode);
                    if (!readyRoom) return;
                    
                    if (readyRoom.host === ws) {
                        readyRoom.hostReady = true;
                    } else if (readyRoom.guest === ws) {
                        readyRoom.guestReady = true;
                    }
                    
                    // Notificar oponente
                    broadcast(msg.roomCode, { type: 'opponent_ready' }, ws);
                    
                    // Se ambos prontos, iniciar round de julgamento
                    if (readyRoom.hostReady && readyRoom.guestReady) {
                        broadcast(msg.roomCode, { type: 'both_ready' });
                        readyRoom.hostReady = false;
                        readyRoom.guestReady = false;
                    }
                    break;

                case 'code_update':
                    // Sincronizar código em tempo real
                    const codeRoom = wsToRoom.get(ws);
                    if (!codeRoom) return;
                    
                    broadcast(codeRoom, {
                        type: 'opponent_code',
                        code: msg.code
                    }, ws);
                    break;

                case 'final_code':
                    // Código final para julgamento
                    const finalRoom = wsToRoom.get(ws);
                    if (!finalRoom) return;
                    
                    broadcast(finalRoom, {
                        type: 'opponent_final_code',
                        code: msg.code
                    }, ws);
                    break;

                case 'judge_result':
                    // Compartilhar resultado do julgamento
                    const judgeRoom = wsToRoom.get(ws);
                    if (!judgeRoom) return;
                    
                    broadcast(judgeRoom, {
                        type: 'opponent_judge',
                        result: msg.result
                    }, ws);
                    break;

                // WebRTC signaling
                case 'webrtc_offer':
                case 'webrtc_answer':
                case 'webrtc_ice':
                    const rtcRoom = wsToRoom.get(ws);
                    if (!rtcRoom) return;
                    broadcast(rtcRoom, msg, ws);
                    break;

                default:
                    console.log('Tipo de mensagem desconhecido:', msg.type);
            }
        } catch (err) {
            console.error('Erro ao processar mensagem:', err);
        }
    });

    ws.on('close', () => {
        const roomCode = wsToRoom.get(ws);
        if (roomCode) {
            const room = rooms.get(roomCode);
            if (room) {
                // Notificar oponente que o jogador desconectou
                broadcast(roomCode, { type: 'opponent_disconnected' }, ws);
                
                // Remover sala se host desconectar
                if (room.host === ws) {
                    rooms.delete(roomCode);
                    console.log(`Sala ${roomCode} removida (host desconectou)`);
                } else {
                    room.guest = null;
                    room.guestReady = false;
                }
            }
            wsToRoom.delete(ws);
        }
        console.log('Conexão fechada');
    });

    ws.on('error', (err) => {
        console.error('Erro no WebSocket:', err);
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor Arena Showdown rodando na porta ${PORT}`);
    console.log(`🌐 Acesse: http://localhost:${PORT}`);
});
