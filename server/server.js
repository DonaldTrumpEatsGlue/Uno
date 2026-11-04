const crypto = require('node:crypto');
const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');
const {
  createGame,
  drawCard,
  takePenalty,
  callUno,
  playCard,
  isPlayable,
  publicState,
} = require('./uno-game');

const port = Number(process.env.PORT || process.env.UNO_PORT || 3001);
const supabaseUrl = (process.env.SUPABASE_URL || 'https://ujfytzwwgeocnmkgkhao.supabase.co').replace(/\/+$/, '');
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_ngixVSTMzYQYxQF8VREnAg_c0pI23RQ';
const allowedOrigins = (process.env.UNO_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
const rooms = new Map();
const connections = new WeakMap();
const roomLifetimeMs = 30 * 60 * 1000;
const reconnectGraceMs = 90 * 1000;
const maxMessageBytes = 16 * 1024;
const maxChatLength = 240;
const maxRooms = 250;
const botTurnDelayMs = 650;

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function normalizeName(name) {
  const cleaned = String(name || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 1 || cleaned.length > 20) throw new Error('Names must be 1–20 characters.');
  return cleaned;
}

async function getAccountName(accessToken) {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Openboard account play is not configured on this UNO server.');
  }
  const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${accessToken}` },
  });
  if (!authResponse.ok) throw new Error('Your account session is invalid or expired. Sign in again.');
  const user = await authResponse.json();
  const profileUrl = new URL(`${supabaseUrl}/rest/v1/profiles`);
  profileUrl.searchParams.set('id', `eq.${user.id}`);
  profileUrl.searchParams.set('select', 'username');
  profileUrl.searchParams.set('limit', '1');
  const profileResponse = await fetch(profileUrl, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!profileResponse.ok) throw new Error('Could not load your Openboard player profile.');
  const profiles = await profileResponse.json();
  const profileName = profiles[0]?.username || user.user_metadata?.username || user.email?.split('@')[0];
  return normalizeName(profileName);
}

function getRoom(code) {
  const room = rooms.get(normalizeCode(code));
  if (!room) throw new Error('Room not found. Check the invite code and try again.');
  return room;
}

function socketsInRoom(room) {
  return room.players.map((player) => player.socket).filter((socket) => socket?.readyState === WebSocket.OPEN);
}

function publicRooms() {
  return [...rooms.values()]
    .filter((room) => room.visibility === 'public' && room.status === 'waiting')
    .map((room) => ({
      code: room.code,
      host: room.players[0]?.name || 'Player',
      players: room.players.filter((player) => player.socket).length,
      maxPlayers: room.maxPlayers,
    }));
}

function broadcastRoom(room) {
  for (const player of room.players) {
    if (player.socket) send(player.socket, { type: 'room-state', state: publicState(room.game, room, player.id) });
  }
  broadcastPublicRooms();
}

function broadcastPublicRooms() {
  const payload = JSON.stringify({ type: 'public-rooms', rooms: publicRooms() });
  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

function roomForSocket(socket) {
  const session = connections.get(socket);
  if (!session?.playerId || !session.roomCode) return null;
  const room = rooms.get(session.roomCode);
  if (!room) return null;
  const player = room.players.find((candidate) => candidate.id === session.playerId);
  return player ? { room, player, session } : null;
}

function sendError(socket, error) {
  send(socket, { type: 'error', message: error.message || 'That request could not be completed.' });
}

function createRoom(socket, message) {
  const session = connections.get(socket);
  if (!session?.playerId || !session.name) throw new Error('Choose a guest name or sign in first.');
  if (rooms.size >= maxRooms) throw new Error('The server is busy. Try creating a room again later.');
  const maxPlayers = Number(message.maxPlayers);
  if (![2, 3, 4].includes(maxPlayers)) throw new Error('Choose a room size from two to four players.');
  const visibility = message.visibility === 'public' ? 'public' : 'private';
  let code;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(code));
  const player = {
    id: session.playerId,
    name: session.name,
    socket,
    resumeToken: crypto.randomBytes(24).toString('hex'),
    reconnectTimer: null,
  };
  const room = {
    code,
    visibility,
    maxPlayers,
    hostId: player.id,
    status: 'waiting',
    players: [player],
    game: null,
    chat: [],
    rematchVotes: new Set(),
    botFillEnabled: message.botFillEnabled === true,
    botTimer: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + roomLifetimeMs,
  };
  rooms.set(code, room);
  session.roomCode = code;
  send(socket, { type: 'room-created', code, playerId: player.id, resumeToken: player.resumeToken });
  broadcastRoom(room);
}

function joinRoom(socket, code) {
  const session = connections.get(socket);
  if (!session?.playerId || !session.name) throw new Error('Choose a guest name or sign in first.');
  const room = getRoom(code);
  if (room.status !== 'waiting') throw new Error('This game has already started.');
  if (room.players.length >= room.maxPlayers) throw new Error('This room is full.');
  if (room.players.some((player) => player.name.toLowerCase() === session.name.toLowerCase())) {
    throw new Error('Another player in the room already has that name.');
  }
  const player = {
    id: session.playerId,
    name: session.name,
    socket,
    resumeToken: crypto.randomBytes(24).toString('hex'),
    reconnectTimer: null,
  };
  room.players.push(player);
  session.roomCode = room.code;
  send(socket, { type: 'room-joined', code: room.code, playerId: player.id, resumeToken: player.resumeToken, name: player.name });
  broadcastRoom(room);
}

function resumeRoom(socket, message) {
  const room = getRoom(message.code);
  const player = room.players.find((candidate) => candidate.resumeToken === message.resumeToken);
  if (!player) throw new Error('This reconnect link is no longer valid.');
  clearTimeout(player.reconnectTimer);
  player.socket = socket;
  const session = connections.get(socket);
  session.playerId = player.id;
  session.name = player.name;
  session.roomCode = room.code;
  send(socket, { type: 'room-joined', code: room.code, playerId: player.id, resumeToken: player.resumeToken, name: player.name });
  broadcastRoom(room);
  for (const chatMessage of room.chat) send(socket, { type: 'chat-message', message: chatMessage });
}

function removePlayer(room, playerId, reason = '') {
  const playerIndex = room.players.findIndex((player) => player.id === playerId);
  if (playerIndex < 0) return;
  const [player] = room.players.splice(playerIndex, 1);
  clearTimeout(player.reconnectTimer);
  if (room.status === 'playing') {
    clearTimeout(room.botTimer);
    room.botTimer = null;
    room.status = 'finished';
    room.game.lastAction = reason || `${player.name} left. The game has ended.`;
  } else if (player.id === room.hostId && room.players.length) {
    room.hostId = room.players[0].id;
  }
  if (!room.players.some((candidate) => !candidate.isBot)) {
    clearTimeout(room.botTimer);
    rooms.delete(room.code);
    broadcastPublicRooms();
    return;
  }
  broadcastRoom(room);
}

function startGame(room, playerId) {
  if (room.hostId !== playerId) throw new Error('Only the room host can start the game.');
  if (room.status !== 'waiting') throw new Error('This room is not waiting to start.');
  if (room.botFillEnabled) {
    while (room.players.length < room.maxPlayers) {
      const botNumber = room.players.filter((player) => player.isBot).length + 1;
      room.players.push({
        id: crypto.randomUUID(),
        name: `UNO Bot ${botNumber}`,
        socket: null,
        isBot: true,
        reconnectTimer: null,
      });
    }
  } else if (room.players.length < 2) {
    throw new Error('At least two players must join, or enable bot opponents.');
  }
  room.status = 'playing';
  room.game = createGame(room.players);
  room.chat.length = 0;
  room.rematchVotes.clear();
  broadcastRoom(room);
  scheduleBotTurn(room);
}

function chooseBotCard(game, bot) {
  const playable = bot.hand.filter((card) => isPlayable(game, card));
  if (!playable.length) return null;
  playable.sort((left, right) => {
    const score = (card) => (card.color === game.activeColor ? 3 : 0) + (card.value >= 10 ? 1 : 0);
    return score(right) - score(left);
  });
  return playable[0];
}

function chooseBotColor(bot, playedCard) {
  const counts = Object.fromEntries(['Red', 'Blue', 'Green', 'Yellow'].map((color) => [
    color,
    bot.hand.filter((card) => card.id !== playedCard.id && card.color === color).length,
  ]));
  return Object.keys(counts).sort((left, right) => counts[right] - counts[left])[0];
}

function runBotTurn(room, bot) {
  if (room.status !== 'playing' || !room.game || room.game.players[room.game.turn]?.id !== bot.id) return;
  const gamePlayer = room.game.players.find((player) => player.id === bot.id);
  if (!gamePlayer) return;

  if (room.game.drawStack) {
    const response = gamePlayer.hand.find((card) => card.value === room.game.drawStack.value);
    if (!response) {
      takePenalty(room.game, bot.id);
    } else {
      if (gamePlayer.hand.length === 2) callUno(room.game, bot.id);
      playCard(room.game, bot.id, response.id, response.value >= 13 ? chooseBotColor(gamePlayer, response) : null);
    }
  } else {
    const card = chooseBotCard(room.game, gamePlayer);
    if (!card) {
      drawCard(room.game, bot.id);
    } else {
      if (gamePlayer.hand.length === 2) callUno(room.game, bot.id);
      playCard(room.game, bot.id, card.id, card.value >= 13 ? chooseBotColor(gamePlayer, card) : null);
    }
  }

  if (room.game.winnerId) room.status = 'finished';
  broadcastRoom(room);
  scheduleBotTurn(room);
}

function scheduleBotTurn(room) {
  clearTimeout(room.botTimer);
  room.botTimer = null;
  if (room.status !== 'playing' || !room.game) return;
  const currentPlayerId = room.game.players[room.game.turn]?.id;
  const bot = room.players.find((player) => player.id === currentPlayerId && player.isBot);
  if (!bot) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    try {
      runBotTurn(room, bot);
    } catch (error) {
      console.error(`UNO bot turn failed in room ${room.code}:`, error);
      room.status = 'finished';
      room.game.lastAction = `${bot.name} could not complete its turn.`;
      broadcastRoom(room);
    }
  }, botTurnDelayMs);
  room.botTimer.unref?.();
}

function performAction(socket, message) {
  const context = roomForSocket(socket);
  if (!context) throw new Error('Join a room before playing.');
  const { room, player } = context;
  if (room.status !== 'playing' || !room.game) throw new Error('The game has not started.');
  switch (message.type) {
    case 'play-card':
      playCard(room.game, player.id, message.cardId, message.color);
      break;
    case 'draw-card':
      drawCard(room.game, player.id);
      break;
    case 'take-penalty':
      takePenalty(room.game, player.id);
      break;
    case 'call-uno':
      callUno(room.game, player.id);
      break;
    default:
      throw new Error('Unknown game action.');
  }
  if (room.game.winnerId) room.status = 'finished';
  broadcastRoom(room);
  scheduleBotTurn(room);
}

function handleChat(socket, text) {
  const context = roomForSocket(socket);
  if (!context) throw new Error('Join a room before chatting.');
  const body = String(text || '').replace(/[<>]/g, '').trim();
  if (!body || body.length > maxChatLength) throw new Error(`Chat messages must be 1–${maxChatLength} characters.`);
  const entry = { id: crypto.randomUUID(), name: context.player.name, text: body, sentAt: Date.now() };
  context.room.chat.push(entry);
  if (context.room.chat.length > 50) context.room.chat.shift();
  for (const peer of socketsInRoom(context.room)) send(peer, { type: 'chat-message', message: entry });
}

async function identify(socket, message) {
  const name = message.accessToken
    ? await getAccountName(message.accessToken)
    : normalizeName(message.name);
  const session = connections.get(socket);
  session.name = name;
  session.playerId = crypto.randomUUID();
  send(socket, { type: 'identified', playerId: session.playerId, name });
  send(socket, { type: 'public-rooms', rooms: publicRooms() });
}

const server = http.createServer((request, response) => {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
    response.writeHead(403);
    response.end('Origin not allowed');
    return;
  }
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
    response.end();
    return;
  }
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }
  if (request.url === '/config') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({
      supabaseUrl,
      supabaseAnonKey,
      signedInAvailable: Boolean(supabaseUrl && supabaseAnonKey),
    }));
    return;
  }
  response.writeHead(404);
  response.end('Not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes });
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws') {
    socket.destroy();
    return;
  }
  const origin = request.headers.origin;
  if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (webSocket) => wss.emit('connection', webSocket, request));
});

wss.on('connection', (socket) => {
  connections.set(socket, { identified: false, messages: [] });
  const identifyTimer = setTimeout(() => {
    if (!connections.get(socket)?.identified) socket.close(1008, 'Identify before joining a room.');
  }, 10_000);
  socket.on('message', async (buffer) => {
    const session = connections.get(socket);
    if (!session) return;
    const now = Date.now();
    session.messages = session.messages.filter((time) => now - time < 10_000);
    if (session.messages.length >= 50) {
      sendError(socket, new Error('Too many requests. Wait a moment and try again.'));
      return;
    }
    session.messages.push(now);
    try {
      const message = JSON.parse(buffer.toString());
      if (!session.identified) {
        if (message.type === 'resume-room') {
          session.identified = true;
          resumeRoom(socket, message);
          return;
        }
        if (message.type !== 'identify') throw new Error('Identify before joining a room.');
        await identify(socket, message);
        session.identified = true;
        clearTimeout(identifyTimer);
        return;
      }
      if (message.type === 'create-room') createRoom(socket, message);
      else if (message.type === 'join-room') joinRoom(socket, message.code);
      else if (message.type === 'list-rooms') send(socket, { type: 'public-rooms', rooms: publicRooms() });
      else if (message.type === 'start-game') {
        const context = roomForSocket(socket);
        if (!context) throw new Error('Join a room before starting.');
        startGame(context.room, context.player.id);
      } else if (message.type === 'set-bot-fill') {
        const context = roomForSocket(socket);
        if (!context) throw new Error('Join a room before changing its settings.');
        if (context.room.hostId !== context.player.id) throw new Error('Only the room host can change room settings.');
        if (context.room.status !== 'waiting') throw new Error('Bot settings cannot change after the game starts.');
        if (typeof message.enabled !== 'boolean') throw new Error('Choose whether bot opponents should fill open seats.');
        context.room.botFillEnabled = message.enabled;
        broadcastRoom(context.room);
      } else if (['play-card', 'draw-card', 'take-penalty', 'call-uno'].includes(message.type)) performAction(socket, message);
      else if (message.type === 'chat') handleChat(socket, message.text);
      else if (message.type === 'leave-room') {
        const context = roomForSocket(socket);
        if (context) removePlayer(context.room, context.player.id, `${context.player.name} left. The game has ended.`);
        session.roomCode = null;
        session.playerId = crypto.randomUUID();
      } else if (message.type === 'rematch') {
        const context = roomForSocket(socket);
        if (!context || context.room.status !== 'finished') throw new Error('There is no finished game to rematch.');
        if (context.room.players.length < 2) throw new Error('At least two players are needed for a rematch.');
        if (context.room.players.some((player) => !player.isBot && !player.socket)) throw new Error('Wait for every player to reconnect before starting a rematch.');
        context.room.rematchVotes.add(context.player.id);
        const humanPlayers = context.room.players.filter((player) => !player.isBot);
        if (context.room.rematchVotes.size >= humanPlayers.length) {
          context.room.game = createGame(context.room.players);
          context.room.status = 'playing';
          context.room.rematchVotes.clear();
          context.room.chat.length = 0;
        }
        broadcastRoom(context.room);
        scheduleBotTurn(context.room);
      } else throw new Error('Unknown request.');
    } catch (error) {
      sendError(socket, error);
    }
  });
  socket.on('close', () => {
    clearTimeout(identifyTimer);
    const context = roomForSocket(socket);
    if (!context || context.player.socket !== socket) return;
    const { room, player } = context;
    player.socket = null;
    broadcastRoom(room);
    player.reconnectTimer = setTimeout(() => {
      if (!player.socket && rooms.has(room.code)) {
        removePlayer(room, player.id, `${player.name} disconnected. The game has ended.`);
      }
    }, reconnectGraceMs);
    player.reconnectTimer.unref?.();
  });
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  let removedRoom = false;
  for (const room of rooms.values()) {
    if (now >= room.expiresAt) {
      for (const player of room.players) {
        if (player.socket) send(player.socket, { type: 'room-closed', message: 'This room expired.' });
        player.socket = null;
      }
      rooms.delete(room.code);
      removedRoom = true;
    }
  }
  if (removedRoom) broadcastPublicRooms();
}, 60_000);
cleanupTimer.unref?.();

if (require.main === module) {
  server.listen(port, '0.0.0.0', () => console.log(`UNO server listening on ${port}`));
}

module.exports = { server, wss, rooms };
