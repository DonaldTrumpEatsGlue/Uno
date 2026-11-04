(() => {
  const config = window.UNO_CONFIG || {};
  const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
  const colors = ['Red', 'Blue', 'Green', 'Yellow'];
  const storedSessionKey = 'uno-openboard-session';
  const savedNameKey = 'uno-player-name';
  const resumeStorageKey = 'uno-online-resume';
  const botPreferenceKey = 'uno-online-bot-fill';
  let authSession = readStoredSession();
  let socket = null;
  let connected = false;
  let identityMode = 'guest';
  let playerId = null;
  let playerName = '';
  let currentRoom = null;
  let currentGame = null;
  let publicRoomList = [];
  let reconnectData = readResumeData();
  let reconnectTimer = null;
  let isReconnecting = false;
  let toastTimer = null;
  const previousCardCounts = new Map();
  let lastRenderedTopCardId = null;
  const embedded = new URLSearchParams(location.search).get('embed') === '1';

  if (embedded) document.body.classList.add('embedded-online');

  function readBotPreference() {
    try {
      return localStorage.getItem(botPreferenceKey) === 'true';
    } catch (error) {
      console.error('Could not read the saved bot setting:', error);
      return false;
    }
  }

  function saveBotPreference(enabled) {
    elements['bot-fill-setting'].checked = enabled;
    try {
      localStorage.setItem(botPreferenceKey, String(enabled));
    } catch (error) {
      console.error('Could not save the bot setting:', error);
      setFeedback('Could not save this setting in your browser.');
    }
  }

  function readStoredSession() {
    try {
      return JSON.parse(localStorage.getItem(storedSessionKey) || 'null');
    } catch (error) {
      console.error('Could not read the saved Openboard session:', error);
      return null;
    }
  }

  function readResumeData() {
    try {
      return JSON.parse(sessionStorage.getItem(resumeStorageKey) || 'null');
    } catch (error) {
      console.error('Could not read the saved room reconnect token:', error);
      return null;
    }
  }

  function setFeedback(message = '') {
    elements['identity-feedback'].textContent = message;
  }

  function reportEmbeddedHeight() {
    if (embedded && window.parent !== window) {
      window.parent.postMessage({
        type: 'uno-embed-state',
        inGame: Boolean(currentRoom && currentRoom.status !== 'waiting'),
      }, location.origin);
    }
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 3200);
  }

  function setConnectionState(isConnected, text) {
    connected = isConnected;
    elements['connection-dot'].classList.toggle('connected', isConnected);
    elements['connection-label'].textContent = text;
    elements['create-room'].disabled = !isConnected;
    elements['join-room'].disabled = !isConnected;
    elements['refresh-rooms'].disabled = !isConnected;
  }

  function wsUrlToHttp(url) {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    parsed.pathname = parsed.pathname.replace(/\/ws\/?$/, '');
    return parsed;
  }

  async function getServerConfig() {
    const serverUrl = config.serverUrl || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname || 'localhost'}:3001/ws`;
    const endpoint = wsUrlToHttp(serverUrl);
    try {
      const response = await fetch(new URL('/config', endpoint));
      if (!response.ok) throw new Error('Online server configuration is unavailable.');
      return { serverUrl, ...(await response.json()) };
    } catch (error) {
      console.warn('Using local online configuration:', error);
      return { serverUrl, supabaseUrl: config.supabaseUrl || '', supabaseAnonKey: config.supabaseAnonKey || '' };
    }
  }

  async function signIn(event) {
    event.preventDefault();
    const settings = await getServerConfig();
    if (!settings.supabaseUrl || !settings.supabaseAnonKey) {
      setFeedback('Account sign-in is not configured on the online server. You can still play as a guest.');
      return;
    }
    const email = elements['account-email'].value.trim();
    const password = elements['account-password'].value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 72) {
      setFeedback('Enter your Openboard email and password.');
      return;
    }
    const submit = elements['account-form'].querySelector('button[type="submit"]');
    submit.disabled = true;
    setFeedback('Signing in…');
    try {
      const response = await fetch(`${settings.supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: settings.supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.msg || result.message || 'Sign-in failed. Check your email and password.');
      authSession = result;
      localStorage.setItem(storedSessionKey, JSON.stringify(result));
      elements['account-password'].value = '';
      elements['account-form'].hidden = true;
      elements['signed-in-name'].hidden = false;
      elements['signed-in-name'].textContent = 'Signed in. Connect to enter a room.';
      elements['connect-button'].textContent = 'Connect with Openboard account';
      setFeedback('');
    } catch (error) {
      setFeedback(error.message || 'Could not sign in.');
    } finally {
      submit.disabled = false;
    }
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      showToast('Not connected to the UNO server.');
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  async function connect(reconnect = false) {
    if (socket?.readyState === WebSocket.OPEN) {
      showToast('You are already connected.');
      return;
    }
    const name = elements['guest-name'].value.replace(/\s+/g, ' ').trim();
    if (!reconnect && identityMode === 'guest' && (name.length < 1 || name.length > 20)) {
      setFeedback('Choose a guest name from 1 to 20 characters.');
      return;
    }
    if (!reconnect && identityMode === 'account' && !authSession?.access_token) {
      setFeedback('Sign in to your Openboard account first.');
      return;
    }
    const settings = await getServerConfig();
    setFeedback('');
    setConnectionState(false, 'Connecting…');
    try {
      socket = new WebSocket(settings.serverUrl);
    } catch (error) {
      setConnectionState(false, 'Could not connect');
      setFeedback(`Could not connect to the online server: ${error.message}`);
      return;
    }
    socket.addEventListener('open', () => {
      setConnectionState(false, 'Identifying…');
      if (reconnect && reconnectData) {
        isReconnecting = true;
        send({ type: 'resume-room', code: reconnectData.code, resumeToken: reconnectData.resumeToken });
      } else {
        send({
          type: 'identify',
          ...(identityMode === 'account' ? { accessToken: authSession.access_token } : { name }),
        });
      }
    }, { once: true });
    socket.addEventListener('message', ({ data }) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        showToast('The server sent an unreadable response.');
        return;
      }
      handleServerMessage(message);
    });
    socket.addEventListener('error', () => {
      setConnectionState(false, 'Connection error');
      setFeedback('Could not reach the online server. Try again in a moment.');
    });
    socket.addEventListener('close', () => {
      setConnectionState(false, 'Disconnected');
      if (currentRoom && reconnectData && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect(true);
        }, 1200);
      }
    });
  }

  function handleServerMessage(message) {
    if (message.type === 'error') {
      setFeedback(message.message);
      showToast(message.message);
      if (isReconnecting) {
        isReconnecting = false;
        reconnectData = null;
        currentRoom = null;
        currentGame = null;
        sessionStorage.removeItem(resumeStorageKey);
        elements['room-view'].hidden = true;
        elements['landing-view'].hidden = false;
        socket?.close();
        setTimeout(() => connect(false), 250);
      }
    } else if (message.type === 'identified') {
      playerId = message.playerId;
      playerName = message.name;
      setConnectionState(true, `Connected as ${playerName}`);
      elements['signed-in-name'].hidden = identityMode !== 'account';
      if (identityMode === 'account') elements['signed-in-name'].textContent = `Playing as @${playerName}`;
      setFeedback('');
      send({ type: 'list-rooms' });
    } else if (message.type === 'room-created' || message.type === 'room-joined') {
      playerId = message.playerId || playerId;
      playerName = message.name || playerName;
      setConnectionState(true, `Connected as ${playerName || 'player'}`);
      reconnectData = { code: message.code, resumeToken: message.resumeToken };
      sessionStorage.setItem(resumeStorageKey, JSON.stringify(reconnectData));
      currentRoom = { code: message.code };
      elements['room-code'].value = message.code;
      elements['landing-view'].hidden = true;
      elements['room-view'].hidden = false;
      elements['room-code-label'].textContent = message.code;
      isReconnecting = false;
    } else if (message.type === 'room-state') {
      currentRoom = message.state.room;
      playerId = playerId || message.state.players.find((player) => player.name === playerName)?.id;
      currentGame = message.state.game;
      renderRoom(message.state);
    } else if (message.type === 'public-rooms') {
      publicRoomList = message.rooms || [];
      renderPublicRooms();
    } else if (message.type === 'chat-message') {
      appendChatMessage(message.message);
    } else if (message.type === 'room-closed') {
      clearRoom(false);
      showToast(message.message);
    }
  }

  function clearRoom(leaveRoom = true) {
    if (leaveRoom && currentRoom && socket?.readyState === WebSocket.OPEN) send({ type: 'leave-room' });
    currentRoom = null;
    currentGame = null;
    reconnectData = null;
    sessionStorage.removeItem(resumeStorageKey);
    elements['chat-log'].replaceChildren();
    elements['room-view'].hidden = true;
    elements['landing-view'].hidden = false;
    if (socket?.readyState === WebSocket.OPEN) send({ type: 'list-rooms' });
  }

  function renderPublicRooms() {
    const list = elements['public-rooms'];
    list.replaceChildren();
    if (!publicRoomList.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = connected ? 'No public rooms are waiting. Start one and invite people to join.' : 'Connect to see tables that are waiting for players.';
      list.append(empty);
      return;
    }
    for (const room of publicRoomList) {
      const card = document.createElement('article');
      card.className = 'public-room';
      const summary = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `Room ${room.code}`;
      const details = document.createElement('small');
      details.textContent = `${room.host} · ${room.players}/${room.maxPlayers} players`;
      summary.append(title, details);
      const join = document.createElement('button');
      join.className = 'quiet-button';
      join.type = 'button';
      join.textContent = 'Join';
      join.disabled = !connected;
      join.addEventListener('click', () => send({ type: 'join-room', code: room.code }));
      card.append(summary, join);
      list.append(card);
    }
  }

  function renderRoom(state) {
    const { room, players, game } = state;
    currentRoom = room;
    currentGame = game;
    elements['landing-view'].hidden = true;
    elements['room-view'].hidden = false;
    elements['room-code-label'].textContent = room.code;
    elements['room-visibility-label'].textContent = `${room.visibility.toUpperCase()} ROOM · ${room.maxPlayers} SEATS`;
    elements['room-lobby-panel'].hidden = room.status !== 'waiting';
    elements['game-view'].hidden = room.status === 'waiting';
    elements['room-status'].textContent = room.status === 'waiting'
      ? 'Waiting for players to join. Share the code with friends.'
      : room.status === 'playing' ? 'Match in progress.' : 'This match has ended.';
    reportEmbeddedHeight();

    const me = players.find((player) => player.id === playerId);
    const lobbyPlayers = elements['lobby-players'];
    lobbyPlayers.replaceChildren();
    for (const player of players) {
      const row = document.createElement('div');
      row.className = 'player-item';
      const name = document.createElement('strong');
      name.textContent = player.name + (player.id === room.hostId ? ' · Host' : player.isBot ? ' · BOT' : '');
      const status = document.createElement('small');
      status.textContent = player.isBot ? 'Computer opponent' : player.connected ? 'Connected' : 'Reconnecting…';
      row.append(name, status);
      lobbyPlayers.append(row);
    }
    const start = elements['start-game'];
    start.hidden = room.status !== 'waiting' || me?.id !== room.hostId;
    const humanCount = players.filter((player) => !player.isBot).length;
    start.disabled = humanCount < 2 && !room.botFillEnabled;
    start.textContent = room.botFillEnabled ? 'Start with bots' : 'Start game';
    elements['bot-fill-row'].hidden = room.status !== 'waiting' || me?.id !== room.hostId;
    elements['bot-fill-lobby'].checked = room.botFillEnabled;
    elements['room-instructions'].textContent = room.botFillEnabled
      ? `Open seats will be filled with bots when the host starts. ${players.length}/${room.maxPlayers} seats filled.`
      : humanCount < 2
        ? `Waiting for another player. Enable bots to play solo. ${players.length}/${room.maxPlayers} seats filled.`
        : `${humanCount} players are ready. The host can start the game.`;

    if (room.status !== 'waiting') renderGame(state);
  }

  function renderGame(state) {
    const { players, game, room } = state;
    if (!game) return;
    const me = players.find((player) => player.id === playerId);
    const isMyTurn = game.turnPlayerId === playerId && room.status === 'playing';
    const ownGamePlayer = game.hand;
    const hand = elements['my-hand'];
    const previousHandScroll = hand.scrollLeft;
    hand.replaceChildren();
    elements['my-name'].textContent = me?.name || playerName || 'You';
    elements['my-card-count'].textContent = `${ownGamePlayer.length} ${ownGamePlayer.length === 1 ? 'card' : 'cards'}`;
    elements['my-avatar'].textContent = (me?.name || playerName || 'Y').trim().charAt(0).toUpperCase();

    for (const card of ownGamePlayer) {
      const button = createCard(card, true);
      const playable = isPlayable(game, card);
      button.classList.toggle('playable', playable);
      button.dataset.cardId = card.id;
      button.disabled = !isMyTurn || !playable;
      button.setAttribute('aria-label', describeCard(card));
      button.addEventListener('click', () => {
        if ([13, 14].includes(card.value)) {
          elements['wild-dialog'].showModal();
          for (const choice of elements['wild-dialog'].querySelectorAll('[data-color]')) {
            choice.onclick = () => {
              elements['wild-dialog'].close();
              send({ type: 'play-card', cardId: card.id, color: choice.dataset.color });
            };
          }
        } else send({ type: 'play-card', cardId: card.id });
      });
      hand.append(button);
    }
    hand.scrollLeft = Math.min(previousHandScroll, hand.scrollWidth - hand.clientWidth);

    const others = elements['other-players'];
    others.replaceChildren();
    const otherPlayers = players.filter((candidate) => candidate.id !== playerId);
    const seatOrder = {
      1: ['top'],
      2: ['right', 'top'],
      3: ['right', 'top', 'left'],
    }[otherPlayers.length] || [];
    for (const [index, player] of otherPlayers.entries()) {
      const tile = document.createElement('div');
      tile.className = `other-player${game.turnPlayerId === player.id ? ' active' : ''}${player.isBot ? ' bot-player' : ''}`;
      tile.dataset.seat = seatOrder[index] || 'top';
      const avatar = document.createElement('span');
      avatar.className = 'player-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = player.isBot ? 'BOT' : player.name.trim().charAt(0).toUpperCase();
      const name = document.createElement('strong');
      name.textContent = player.name + (player.isBot ? ' · BOT' : '');
      const count = document.createElement('small');
      count.textContent = `${player.cardCount} cards${player.connected ? '' : ' · reconnecting'}`;
      const backs = document.createElement('div');
      backs.className = 'card-fan';
      const previousCount = previousCardCounts.get(player.id) ?? player.cardCount;
      const justDrew = player.cardCount > previousCount;
      const visibleBacks = Math.min(player.cardCount, 7);
      for (let index = 0; index < visibleBacks; index += 1) {
        const back = document.createElement('span');
        back.className = 'mini-back';
        if (justDrew && index >= Math.max(0, previousCount)) back.classList.add('just-drew');
        backs.append(back);
      }
      tile.append(avatar, name, backs, count);
      others.append(tile);
      previousCardCounts.set(player.id, player.cardCount);
    }

    const discard = createCard({ ...game.topCard, color: [13, 14].includes(game.topCard.value) ? 'Special' : game.activeColor }, false);
    discard.classList.add('top-card');
    discard.setAttribute('aria-hidden', 'true');
    if (lastRenderedTopCardId !== game.topCard.id) discard.classList.add('card-arriving');
    elements['top-card'].replaceChildren(discard);
    lastRenderedTopCardId = game.topCard.id;
    elements['active-color'].className = `active-color ${game.activeColor.toLowerCase()}`;
    elements['active-color'].querySelector('b').textContent = game.activeColor;
    elements['direction-status'].textContent = game.direction === 1 ? 'Clockwise' : 'Counter-clockwise';
    elements['turn-status'].textContent = game.winnerId
      ? (game.winnerId === playerId ? 'You won!' : `${players.find((player) => player.id === game.winnerId)?.name || 'A player'} won`)
      : isMyTurn ? 'Your turn' : `Waiting for ${players.find((player) => player.id === game.turnPlayerId)?.name || 'a player'}`;
    elements['turn-label'].textContent = game.winnerId ? 'MATCH COMPLETE' : isMyTurn ? 'YOUR TURN' : 'TURN IN PROGRESS';
    elements['turn-prompt'].textContent = game.winnerId
      ? 'The table is ready for a rematch.'
      : game.drawStack
        ? `Draw penalty +${(game.drawStack.value === 10 ? 2 : 4) * game.drawStack.count} · stack the same card or take the penalty.`
        : isMyTurn && ownGamePlayer.some((card) => isPlayable(game, card))
          ? 'Play one of the highlighted cards.'
          : isMyTurn ? 'No matching card — draw to continue.' : 'Waiting for the active player to make a move.';
    elements['action-status'].textContent = game.winnerId
      ? 'Game over'
      : game.drawStack
        ? `PENALTY +${(game.drawStack.value === 10 ? 2 : 4) * game.drawStack.count}`
        : 'Match in progress';
    elements['draw-hint'].textContent = isMyTurn && !game.drawStack
      ? (ownGamePlayer.some((card) => isPlayable(game, card)) ? 'Play a matching card' : 'No match · draw')
      : '';
    elements['draw-card'].disabled = !isMyTurn || Boolean(game.drawStack) || ownGamePlayer.some((card) => isPlayable(game, card));
    elements['take-penalty'].hidden = !isMyTurn || !game.drawStack;
    elements['take-penalty'].textContent = game.drawStack
      ? `Take +${(game.drawStack.value === 10 ? 2 : 4) * game.drawStack.count}`
      : 'Take penalty';
    elements['stack-status'].textContent = game.drawStack
      ? `Draw stack: +${(game.drawStack.value === 10 ? 2 : 4) * game.drawStack.count}. Play the same draw card or take them.`
      : '';
    elements['call-uno'].hidden = ownGamePlayer.length !== 2;
    elements['call-uno'].disabled = !isMyTurn;
    elements['uno-reminder'].hidden = !isMyTurn || ownGamePlayer.length !== 2;
    elements['last-action'].textContent = game.lastAction;
    elements['result-panel'].hidden = room.status !== 'finished';
    elements['result-title'].textContent = game.winnerId === playerId ? 'You won the table!' : game.winnerId
      ? `${players.find((player) => player.id === game.winnerId)?.name || 'A player'} won!`
      : game.lastAction;
    const winner = players.find((player) => player.id === game.winnerId);
    elements['result-avatar'].textContent = winner?.isBot ? 'BOT' : (winner?.name || '★').trim().charAt(0).toUpperCase();
    elements['result-message'].textContent = game.winnerId === playerId
      ? 'Congratulations! You cleared your hand and won the table.'
      : `${winner?.name || 'The winner'} cleared their hand. Rematch?`;
    const standings = [...players].sort((first, second) => {
      if (first.id === game.winnerId) return -1;
      if (second.id === game.winnerId) return 1;
      return first.cardCount - second.cardCount;
    });
    elements['final-standings'].replaceChildren();
    for (const [index, player] of standings.entries()) {
      const item = document.createElement('li');
      const rank = document.createElement('span');
      rank.textContent = `${index + 1}. ${player.name}${player.id === playerId ? ' (you)' : ''}`;
      const cards = document.createElement('strong');
      cards.textContent = player.id === game.winnerId ? 'Winner' : `${player.cardCount} left`;
      item.append(rank, cards);
      elements['final-standings'].append(item);
    }
    elements.rematch.textContent = room.hasVotedRematch
      ? `Waiting for players (${room.rematchVotes}/${players.filter((player) => !player.isBot).length})`
      : `Vote for rematch (${room.rematchVotes}/${players.filter((player) => !player.isBot).length})`;
    elements.rematch.disabled = room.status !== 'finished' || players.filter((player) => !player.isBot).length < 1 || room.hasVotedRematch;
  }

  function isPlayable(game, card) {
    if (game.drawStack) return card.value === game.drawStack.value;
    return card.color === game.activeColor || card.color === 'Special' || card.value === game.topCard.value;
  }

  function describeCard(card) {
    const kind = card.value === 10 ? 'Draw two' : card.value === 11 ? 'Reverse' : card.value === 12 ? 'Skip'
      : card.value === 13 ? 'Wild' : card.value === 14 ? 'Wild draw four' : String(card.value);
    return `${card.color === 'Special' ? 'Wild' : card.color} ${kind}`;
  }

  function createCard(card, interactive) {
    const element = document.createElement(interactive ? 'button' : 'div');
    element.className = 'card';
    if (interactive) {
      element.type = 'button';
      element.classList.add('hand-card');
    }
    const inner = document.createElement('span');
    inner.className = 'inner';
    const mark = document.createElement('span');
    mark.className = 'mark';
    addCSSDesignToCard(element, mark, card.value);
    const classColor = card.color === 'Special' ? 'black' : card.color.toLowerCase();
    element.classList.add(classColor);
    inner.append(mark);
    element.append(inner);
    return element;
  }

  function appendChatMessage(message) {
    const row = document.createElement('div');
    row.className = 'chat-line';
    const name = document.createElement('strong');
    name.textContent = `${message.name}: `;
    const text = document.createElement('span');
    text.textContent = message.text;
    row.append(name, text);
    elements['chat-log'].append(row);
    elements['chat-log'].scrollTop = elements['chat-log'].scrollHeight;
  }

  document.querySelectorAll('.mode-button').forEach((button) => {
    button.addEventListener('click', () => {
      identityMode = button.dataset.mode;
      document.querySelectorAll('.mode-button').forEach((modeButton) => modeButton.classList.toggle('active', modeButton === button));
      elements['guest-fields'].hidden = identityMode !== 'guest';
      elements['account-form'].hidden = identityMode !== 'account' || Boolean(authSession?.access_token);
      elements['connect-button'].textContent = identityMode === 'account'
        ? (authSession?.access_token ? 'Connect with Openboard account' : 'Sign in above to connect')
        : 'Connect to online tables';
      elements['signed-in-name'].hidden = identityMode !== 'account' || !authSession?.access_token;
    });
    if (embedded) {
      try {
        elements['guest-name'].value = localStorage.getItem(savedNameKey) || '';
      } catch (error) {
        console.error('Could not read the shared player name:', error);
      }
      elements['guest-name'].addEventListener('input', () => {
        try {
          localStorage.setItem(savedNameKey, elements['guest-name'].value);
        } catch (error) {
          console.error('Could not save the shared player name:', error);
        }
      });
      elements['online-back-link'].addEventListener('click', (event) => {
        event.preventDefault();
        window.parent.postMessage({ type: 'uno-embed-close' }, location.origin);
      });
      window.addEventListener('message', (event) => {
        if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'uno-leave-room') return;
        clearRoom();
      });
      new ResizeObserver(reportEmbeddedHeight).observe(document.body);
      reportEmbeddedHeight();
    }
  });
  elements['account-form'].addEventListener('submit', signIn);
  elements['connect-button'].addEventListener('click', () => connect());
  elements['create-room'].addEventListener('click', () => send({
    type: 'create-room',
    maxPlayers: Number(elements['room-size'].value),
    visibility: elements['room-public'].checked ? 'public' : 'private',
    botFillEnabled: elements['bot-fill-setting'].checked,
  }));
  elements['bot-fill-setting'].checked = readBotPreference();
  elements['bot-fill-setting'].addEventListener('change', () => {
    saveBotPreference(elements['bot-fill-setting'].checked);
  });
  elements['bot-fill-lobby'].addEventListener('change', () => {
    saveBotPreference(elements['bot-fill-lobby'].checked);
    send({ type: 'set-bot-fill', enabled: elements['bot-fill-lobby'].checked });
  });
  elements['join-room'].addEventListener('click', () => send({ type: 'join-room', code: elements['room-code'].value }));
  elements['room-code'].addEventListener('input', () => {
    elements['room-code'].value = elements['room-code'].value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  elements['room-code'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter') elements['join-room'].click();
  });
  elements['refresh-rooms'].addEventListener('click', () => send({ type: 'list-rooms' }));
  elements['start-game'].addEventListener('click', () => send({ type: 'start-game' }));
  elements['leave-room'].addEventListener('click', () => {
    if (send({ type: 'leave-room' })) {
      currentRoom = null;
      currentGame = null;
      reconnectData = null;
      sessionStorage.removeItem(resumeStorageKey);
      elements['room-view'].hidden = true;
      elements['landing-view'].hidden = false;
    }
  });
  elements['copy-code'].addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(currentRoom?.code || elements['room-code-label'].textContent);
      showToast('Invite code copied.');
    } catch (error) {
      console.error('Could not copy the room code:', error);
      showToast(`Share room code ${currentRoom?.code || elements['room-code-label'].textContent}`);
    }
  });
  elements['draw-card'].addEventListener('click', () => send({ type: 'draw-card' }));
  elements['take-penalty'].addEventListener('click', () => send({ type: 'take-penalty' }));
  elements['call-uno'].addEventListener('click', () => send({ type: 'call-uno' }));
  elements['chat-form'].addEventListener('submit', (event) => {
    event.preventDefault();
    const text = elements['chat-input'].value.trim();
    if (send({ type: 'chat', text })) elements['chat-input'].value = '';
  });
  elements.rematch.addEventListener('click', () => send({ type: 'rematch' }));
  elements['back-to-lobby'].addEventListener('click', clearRoom);

  if (authSession?.access_token) {
    identityMode = 'account';
    document.querySelector('[data-mode="account"]').classList.add('active');
    document.querySelector('[data-mode="guest"]').classList.remove('active');
    elements['guest-fields'].hidden = true;
    elements['account-form'].hidden = true;
    elements['signed-in-name'].hidden = false;
    elements['signed-in-name'].textContent = 'Openboard account saved. Connect when you are ready.';
    elements['connect-button'].textContent = 'Connect with Openboard account';
  }

  if (reconnectData) connect(true);
  else renderPublicRooms();
  reportEmbeddedHeight();
})();
