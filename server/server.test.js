const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { server, rooms } = require('./server');

let serverUrl;
const sockets = [];

function waitFor(socket, type, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}.`)), 3000);
    const onMessage = (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.type !== type || !predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function connectPlayer(name) {
  const socket = new WebSocket(serverUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const identified = waitFor(socket, 'identified');
  socket.send(JSON.stringify({ type: 'identify', name }));
  await identified;
  return socket;
}

test('online rooms protect hands, enforce host actions, and require unanimous rematch votes', async (context) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverUrl = `ws://127.0.0.1:${server.address().port}/ws`;
  context.after(async () => {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
    await new Promise((resolve) => server.close(resolve));
    rooms.clear();
  });

  const host = await connectPlayer('Table Host');
  const created = waitFor(host, 'room-created');
  host.send(JSON.stringify({ type: 'create-room', visibility: 'private', maxPlayers: 2 }));
  const room = await created;

  const guest = await connectPlayer('Table Guest');
  const joined = waitFor(guest, 'room-joined');
  const hostLobby = waitFor(host, 'room-state', (message) => message.state.players.length === 2);
  guest.send(JSON.stringify({ type: 'join-room', code: room.code }));
  await Promise.all([joined, hostLobby]);

  const nonHostSetting = waitFor(guest, 'error');
  guest.send(JSON.stringify({ type: 'set-bot-fill', enabled: true }));
  assert.match((await nonHostSetting).message, /Only the room host/);

  const nonHostStart = waitFor(guest, 'error');
  guest.send(JSON.stringify({ type: 'start-game' }));
  assert.match((await nonHostStart).message, /Only the room host/);

  const hostGame = waitFor(host, 'room-state', (message) => message.state.room.status === 'playing');
  const guestGame = waitFor(guest, 'room-state', (message) => message.state.room.status === 'playing');
  host.send(JSON.stringify({ type: 'start-game' }));
  const [hostSnapshot, guestSnapshot] = await Promise.all([hostGame, guestGame]);
  assert.equal(hostSnapshot.state.game.hand.length, 7);
  assert.equal(guestSnapshot.state.game.hand.length, 7);
  assert.equal(JSON.stringify(hostSnapshot).includes(JSON.stringify(guestSnapshot.state.game.hand[0])), false);

  const invalidCard = waitFor(host, 'error');
  host.send(JSON.stringify({ type: 'play-card', cardId: 'not-in-hand' }));
  assert.match((await invalidCard).message, /not in your hand/);

  const activeRoom = rooms.get(room.code);
  const hostPlayer = activeRoom.game.players.find((player) => player.id === activeRoom.hostId);
  const guestPlayer = activeRoom.game.players.find((player) => player.id !== activeRoom.hostId);
  activeRoom.game.turn = activeRoom.game.players.indexOf(hostPlayer);
  activeRoom.game.topCard = { id: 'test-top', color: 'Red', value: 5 };
  activeRoom.game.activeColor = 'Red';
  hostPlayer.hand = [{ id: 'winning-card', color: 'Red', value: 2 }];
  guestPlayer.hand = [{ id: 'remaining-card', color: 'Blue', value: 3 }];

  const finishedForHost = waitFor(host, 'room-state', (message) => message.state.room.status === 'finished');
  const finishedForGuest = waitFor(guest, 'room-state', (message) => message.state.room.status === 'finished');
  host.send(JSON.stringify({ type: 'play-card', cardId: 'winning-card' }));
  await Promise.all([finishedForHost, finishedForGuest]);

  const firstVoteForHost = waitFor(host, 'room-state', (message) => message.state.room.rematchVotes === 1);
  const firstVoteForGuest = waitFor(guest, 'room-state', (message) => message.state.room.rematchVotes === 1);
  host.send(JSON.stringify({ type: 'rematch' }));
  const [hostVote, guestVote] = await Promise.all([firstVoteForHost, firstVoteForGuest]);
  assert.equal(hostVote.state.room.status, 'finished');
  assert.equal(hostVote.state.room.hasVotedRematch, true);
  assert.equal(guestVote.state.room.hasVotedRematch, false);

  const rematchForHost = waitFor(host, 'room-state', (message) => message.state.room.status === 'playing');
  const rematchForGuest = waitFor(guest, 'room-state', (message) => message.state.room.status === 'playing');
  guest.send(JSON.stringify({ type: 'rematch' }));
  const [hostRematch, guestRematch] = await Promise.all([rematchForHost, rematchForGuest]);
  assert.equal(hostRematch.state.game.hand.length, 7);
  assert.equal(guestRematch.state.game.hand.length, 7);
  assert.equal(hostRematch.state.room.rematchVotes, 0);

  const soloCreated = waitFor(host, 'room-created');
  host.send(JSON.stringify({ type: 'leave-room' }));
  host.send(JSON.stringify({ type: 'create-room', visibility: 'private', maxPlayers: 2, botFillEnabled: true }));
  const soloRoomInfo = await soloCreated;
  const soloStarted = waitFor(host, 'room-state', (message) => message.state.room.status === 'playing');
  host.send(JSON.stringify({ type: 'start-game' }));
  const soloSnapshot = await soloStarted;
  const soloRoom = rooms.get(soloRoomInfo.code);
  const bot = soloRoom.players.find((player) => player.isBot);
  assert.ok(bot);
  assert.equal(soloSnapshot.state.players.filter((player) => player.isBot).length, 1);
  assert.equal(soloSnapshot.state.players.find((player) => player.isBot).connected, true);

  const human = soloRoom.game.players.find((player) => player.id === soloRoom.hostId);
  const botGamePlayer = soloRoom.game.players.find((player) => player.id === bot.id);
  soloRoom.game.turn = soloRoom.game.players.indexOf(human);
  soloRoom.game.topCard = { id: 'test-top', color: 'Red', value: 5 };
  soloRoom.game.activeColor = 'Red';
  human.hand = [
    { id: 'human-play', color: 'Red', value: 2 },
    { id: 'human-keep', color: 'Blue', value: 3 },
  ];
  botGamePlayer.hand = [
    { id: 'bot-play', color: 'Red', value: 1 },
    { id: 'bot-keep', color: 'Blue', value: 5 },
  ];
  const botPlayed = waitFor(host, 'room-state', (message) => (
    message.state.room.status === 'playing'
    && message.state.game.lastAction === `${bot.name} played a card.`
    && message.state.game.turnPlayerId === soloRoom.hostId
  ));
  host.send(JSON.stringify({ type: 'play-card', cardId: 'human-play' }));
  const afterBotTurn = await botPlayed;
  assert.equal(afterBotTurn.state.players.find((player) => player.id === bot.id).cardCount, 1);

  soloRoom.game.topCard = { id: 'test-top-2', color: 'Red', value: 5 };
  soloRoom.game.activeColor = 'Red';
  soloRoom.game.turn = soloRoom.game.players.indexOf(human);
  human.hand = [{ id: 'solo-win', color: 'Red', value: 6 }];
  const soloFinished = waitFor(host, 'room-state', (message) => message.state.room.status === 'finished');
  host.send(JSON.stringify({ type: 'play-card', cardId: 'solo-win' }));
  await soloFinished;
  const soloRematch = waitFor(host, 'room-state', (message) => message.state.room.status === 'playing');
  host.send(JSON.stringify({ type: 'rematch' }));
  const soloRematchState = await soloRematch;
  assert.equal(soloRematchState.state.players.filter((player) => player.isBot).length, 1);
  assert.equal(soloRematchState.state.players.find((player) => player.isBot).cardCount, 7);
});
