(() => {
  const setup = document.getElementById('setupGame');
  const onlineMode = document.getElementById('onlineMode');
  const onlineFrame = document.getElementById('onlineGameFrame');
  const playerName = document.getElementById('playerName');
  const savedNameKey = 'uno-player-name';

  try {
    playerName.value = localStorage.getItem(savedNameKey) || '';
  } catch (error) {
    console.error('Could not read the saved player name:', error);
  }

  playerName.addEventListener('input', () => {
    try {
      localStorage.setItem(savedNameKey, playerName.value);
    } catch (error) {
      console.error('Could not save the player name:', error);
    }
  });

  window.showOnlineMode = function () {
    setup.hidden = true;
    onlineMode.hidden = false;
    if (onlineFrame.src === 'about:blank') {
      onlineFrame.src = 'online.html?embed=1';
    }
    window.scrollTo(0, 0);
  };

  window.showMainMenu = function () {
    if (onlineFrame.contentWindow && onlineFrame.src !== 'about:blank') {
      onlineFrame.contentWindow.postMessage({ type: 'uno-leave-room' }, location.origin);
    }
    onlineFrame.src = 'about:blank';
    onlineMode.hidden = true;
    setup.hidden = false;
    setup.classList.remove('d-none');
    document.getElementById('playingField').classList.add('d-none');
    window.scrollTo(0, 0);
  };

  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== onlineFrame.contentWindow) return;
    if (event.data?.type === 'uno-embed-resize' && Number.isFinite(event.data.height)) {
      onlineFrame.style.height = `${Math.max(620, event.data.height)}px`;
    } else if (event.data?.type === 'uno-embed-close') {
      window.showMainMenu();
    }
  });
})();
