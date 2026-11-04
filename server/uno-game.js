const crypto = require('node:crypto');

const COLORS = ['Red', 'Green', 'Blue', 'Yellow'];
const DRAW_VALUES = new Set([10, 14]);

function randomCard(random = Math.random) {
  const colors = [...COLORS, 'Special'];
  let color = colors[Math.floor(random() * colors.length)];
  let value = Math.floor(random() * 13);

  if (color === 'Special') {
    if (Math.floor(random() * 3) < 2) {
      value = Math.floor(random() * 13) % 2 === 0 ? 13 : 14;
    } else {
      color = COLORS[Math.floor(random() * COLORS.length)];
    }
  }

  return { id: crypto.randomUUID(), color, value };
}

function createGame(players, random = Math.random) {
  const gamePlayers = players.map((player) => ({
    id: player.id,
    name: player.name,
    hand: [],
    unoCalled: false,
  }));
  for (const player of gamePlayers) {
    for (let card = 0; card < 7; card += 1) player.hand.push(randomCard(random));
  }

  let topCard = randomCard(random);
  while (topCard.value > 9) topCard = randomCard(random);

  return {
    players: gamePlayers,
    topCard,
    activeColor: topCard.color,
    turn: 0,
    direction: 1,
    drawStack: null,
    winnerId: null,
    lastAction: 'Game started.',
  };
}

function playerIndex(game, playerId) {
  return game.players.findIndex((player) => player.id === playerId);
}

function advance(game, count = 1) {
  for (let step = 0; step < count; step += 1) {
    game.turn = (game.turn + game.direction + game.players.length) % game.players.length;
  }
}

function hasPlayableCard(game, player) {
  return player.hand.some((card) => isPlayable(game, card));
}

function isPlayable(game, card) {
  if (game.drawStack) return card.value === game.drawStack.value;
  return card.color === game.activeColor || card.color === 'Special'
    || card.value === game.topCard.value;
}

function requireCurrentPlayer(game, playerId) {
  if (game.winnerId) throw new Error('This game has already ended.');
  if (game.players[game.turn]?.id !== playerId) throw new Error('It is not your turn.');
  return game.players[game.turn];
}

function drawCard(game, playerId, random = Math.random) {
  const player = requireCurrentPlayer(game, playerId);
  if (game.drawStack) throw new Error('Take the stacked draw penalty or play a matching draw card.');
  if (hasPlayableCard(game, player)) throw new Error('Play a valid card before drawing.');
  player.hand.push(randomCard(random));
  player.unoCalled = false;
  game.lastAction = `${player.name} drew a card.`;
}

function takePenalty(game, playerId, random = Math.random) {
  const player = requireCurrentPlayer(game, playerId);
  if (!game.drawStack) throw new Error('There is no stacked draw penalty.');
  const count = game.drawStack.value === 10 ? 2 : 4;
  const total = count * game.drawStack.count;
  for (let card = 0; card < total; card += 1) player.hand.push(randomCard(random));
  player.unoCalled = false;
  game.lastAction = `${player.name} drew ${total} cards.`;
  game.drawStack = null;
  advance(game);
}

function callUno(game, playerId) {
  const player = requireCurrentPlayer(game, playerId);
  if (player.hand.length !== 2) throw new Error('Call UNO when you have exactly two cards, before playing one.');
  player.unoCalled = true;
  game.lastAction = `${player.name} called UNO!`;
}

function playCard(game, playerId, cardId, chosenColor, random = Math.random) {
  const player = requireCurrentPlayer(game, playerId);
  const cardIndex = player.hand.findIndex((card) => card.id === cardId);
  if (cardIndex < 0) throw new Error('That card is not in your hand.');
  const card = player.hand[cardIndex];
  if (!isPlayable(game, card)) throw new Error('That card does not match the active color or value.');
  if ([13, 14].includes(card.value) && !COLORS.includes(chosenColor)) {
    throw new Error('Choose a color for the wild card.');
  }

  if (player.hand.length === 2 && !player.unoCalled) {
    player.hand.push(randomCard(random), randomCard(random));
    game.lastAction = `${player.name} forgot to call UNO and drew two penalty cards.`;
  } else {
    game.lastAction = `${player.name} played a card.`;
  }
  player.hand.splice(cardIndex, 1);
  player.unoCalled = false;
  game.topCard = { ...card };
  game.activeColor = [13, 14].includes(card.value) ? chosenColor : card.color;

  if (DRAW_VALUES.has(card.value)) {
    game.drawStack = game.drawStack?.value === card.value
      ? { value: card.value, count: game.drawStack.count + 1 }
      : { value: card.value, count: 1 };
  } else if (game.drawStack) {
    throw new Error('A draw stack must be answered with the same draw-card type.');
  }

  if (player.hand.length === 0) {
    game.winnerId = player.id;
    game.lastAction = `${player.name} won!`;
    return;
  }

  if (card.value === 11) game.direction *= -1;
  advance(game, card.value === 12 ? 2 : 1);
}

function publicState(game, room, playerId) {
  return {
    room: {
      code: room.code,
      visibility: room.visibility,
      maxPlayers: room.maxPlayers,
      hostId: room.hostId,
      status: room.status,
      botFillEnabled: room.botFillEnabled === true,
      rematchVotes: room.rematchVotes?.size ?? 0,
      hasVotedRematch: room.rematchVotes?.has(playerId) ?? false,
    },
    players: room.players.map((player) => {
      const statePlayer = game?.players.find((candidate) => candidate.id === player.id);
      return {
        id: player.id,
        name: player.name,
        connected: Boolean(player.isBot || player.socket),
        isBot: Boolean(player.isBot),
        cardCount: statePlayer?.hand.length ?? 0,
      };
    }),
    game: game ? {
      hand: game.players.find((player) => player.id === playerId)?.hand ?? [],
      topCard: game.topCard,
      activeColor: game.activeColor,
      turnPlayerId: game.players[game.turn]?.id ?? null,
      drawStack: game.drawStack,
      winnerId: game.winnerId,
      lastAction: game.lastAction,
      direction: game.direction,
      unoCalled: game.players[game.turn]?.unoCalled ?? false,
    } : null,
  };
}

module.exports = {
  COLORS,
  createGame,
  drawCard,
  takePenalty,
  callUno,
  playCard,
  isPlayable,
  publicState,
};
