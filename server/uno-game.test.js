const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createGame,
  drawCard,
  takePenalty,
  callUno,
  playCard,
  publicState,
} = require('./uno-game');

function deterministicRandom() {
  let value = 0;
  return () => {
    value = (value + 0.173) % 1;
    return value;
  };
}

function gameWithHands(hands, options = {}) {
  return {
    players: hands.map((hand, index) => ({
      id: `p${index}`,
      name: `Player ${index}`,
      hand,
      unoCalled: false,
    })),
    topCard: { id: 'top', color: options.color ?? 'Red', value: options.value ?? 4 },
    activeColor: options.color ?? 'Red',
    turn: 0,
    direction: 1,
    drawStack: options.drawStack ?? null,
    winnerId: null,
    lastAction: 'test',
  };
}

test('new games automatically deal seven cards to every player', () => {
  const game = createGame([
    { id: 'p0', name: 'Player 0' },
    { id: 'p1', name: 'Player 1' },
    { id: 'p2', name: 'Player 2' },
  ]);
  assert.deepEqual(game.players.map((player) => player.hand.length), [7, 7, 7]);
});

test('play validates ownership, turn and matching color or value', () => {
  const game = gameWithHands([[{ id: 'a', color: 'Blue', value: 7 }], []]);
  assert.throws(() => playCard(game, 'p1', 'a', null), /not your turn/);
  assert.throws(() => playCard(game, 'p0', 'missing', null), /not in your hand/);
  assert.throws(() => playCard(game, 'p0', 'a', null), /does not match/);
});

test('wild cards require and apply the chosen color', () => {
  const game = gameWithHands([
    [{ id: 'wild', color: 'Special', value: 13 }, { id: 'keep', color: 'Blue', value: 1 }],
    [{ id: 'next', color: 'Red', value: 1 }],
  ]);
  assert.throws(() => playCard(game, 'p0', 'wild', null), /Choose a color/);
  playCard(game, 'p0', 'wild', 'Blue');
  assert.equal(game.activeColor, 'Blue');
  assert.equal(game.turn, 1);
});

test('failed UNO call adds two cards before the second-to-last card is played', () => {
  const game = gameWithHands([[
    { id: 'play', color: 'Red', value: 4 },
    { id: 'keep', color: 'Blue', value: 1 },
  ], [{ id: 'other', color: 'Green', value: 2 }]]);
  playCard(game, 'p0', 'play', null, deterministicRandom());
  assert.equal(game.players[0].hand.length, 3);
  assert.match(game.lastAction, /drew two penalty cards/);
});

test('UNO call prevents the penalty and draw cards stack by matching type', () => {
  const game = gameWithHands([
    [{ id: 'play', color: 'Red', value: 10 }, { id: 'keep', color: 'Blue', value: 1 }],
    [{ id: 'stack', color: 'Green', value: 10 }, { id: 'other', color: 'Green', value: 3 }],
  ]);
  callUno(game, 'p0');
  playCard(game, 'p0', 'play', null);
  assert.equal(game.players[0].hand.length, 1);
  assert.deepEqual(game.drawStack, { value: 10, count: 1 });
  playCard(game, 'p1', 'stack', null);
  assert.deepEqual(game.drawStack, { value: 10, count: 2 });
  assert.equal(game.turn, 0);
});

test('taking a stacked penalty draws the accumulated amount and advances', () => {
  const game = gameWithHands([
    [{ id: 'other', color: 'Blue', value: 2 }],
    [{ id: 'stack', color: 'Green', value: 10 }],
  ], { drawStack: { value: 10, count: 2 } });
  takePenalty(game, 'p0', deterministicRandom());
  assert.equal(game.players[0].hand.length, 5);
  assert.equal(game.drawStack, null);
  assert.equal(game.turn, 1);
});

test('draw is only available when no valid move exists', () => {
  const game = gameWithHands([[{ id: 'valid', color: 'Red', value: 4 }], []]);
  assert.throws(() => drawCard(game, 'p0', deterministicRandom()), /Play a valid card/);
  game.activeColor = 'Yellow';
  game.topCard.value = 6;
  drawCard(game, 'p0', deterministicRandom());
  assert.equal(game.players[0].hand.length, 2);
  assert.equal(game.turn, 0);
});

test('snapshots expose only the requesting player hand', () => {
  const room = {
    code: 'ABCD',
    visibility: 'private',
    maxPlayers: 2,
    hostId: 'p0',
    status: 'playing',
    players: [
      { id: 'p0', name: 'One', socket: {} },
      { id: 'p1', name: 'Two', socket: {} },
    ],
  };
  const game = gameWithHands([
    [{ id: 'secret-a', color: 'Red', value: 1 }],
    [{ id: 'secret-b', color: 'Blue', value: 2 }],
  ]);
  const view = publicState(game, room, 'p0');
  assert.deepEqual(view.game.hand.map((card) => card.id), ['secret-a']);
  assert.equal(JSON.stringify(view).includes('secret-b'), false);
  assert.equal(view.players[1].cardCount, 1);
});
