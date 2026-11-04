const TOGGLES = [
  ['camBtn', 'Camera', 'Share your video', 'cam'],
  ['micBtn', 'Microphone', 'Let others hear you', 'mic'],
  ['ambientBtn', 'Ambient light', 'Glow around the video', 'glow'],
  ['ecoBtn', 'Battery saver', 'Use less power', 'battery'],
];
const ACTIONS = [
  ['backBtn', 'Back 10 seconds', 'back10'],
  ['fwdBtn', 'Forward 10 seconds', 'fwd10'],
  ['pipBtn', 'Floating cameras', 'pip'],
  ['quickChatBtn', 'Chat', 'chat'],
  ['notificationBtn', 'Notifications', 'bell'],
];
const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';

export function playerMenuState(state) {
  return {
    camBtn: { on: !!state.cam, icon: state.cam ? 'cam' : 'cam-off', detail: 'Share your video' },
    micBtn: { on: !!state.mic, icon: state.mic ? 'mic' : 'mic-off', detail: 'Let others hear you' },
    ambientBtn: { on: !!(state.ambientPreference && state.ambientAllowed), icon: 'glow',
      status: state.ambientPreference && !state.ambientAllowed ? 'Paused' : undefined,
      detail: state.ambientPreference && !state.ambientAllowed ? 'Paused: ' + (state.ambientReason || 'power or motion settings') : 'Glow around the video' },
    ecoBtn: { on: !!state.saver, icon: 'battery',
      detail: state.saver && !state.manualSaver ? 'Automatic: ' + (state.saverReason || 'power settings') : 'Use less power' },
  };
}

export function createPlayerMenu(pop) {
  const doc = pop.ownerDocument, toggles = new Map();
  const grid = doc.createElement('div'), actions = doc.createElement('div');
  grid.className = 'player-menu-toggles'; actions.className = 'player-menu-actions';
  for (const [id, name, detail, symbol] of TOGGLES) {
    const button = doc.createElement('button');
    button.type = 'button'; button.className = 'player-menu-toggle';
    button.dataset.control = id; button.dataset.toggle = 'true';
    button.setAttribute('aria-label', name);
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-describedby', 'menu-detail-' + id);
    button.innerHTML = '<span class="player-menu-top"><span class="player-menu-icon">' + icon(symbol)
      + '</span><span class="player-menu-switch" aria-hidden="true"></span></span>'
      + '<span class="player-menu-name">' + name + '<span class="player-menu-state" aria-hidden="true">Off</span></span>'
      + '<span class="player-menu-detail" id="menu-detail-' + id + '">' + detail + '</span>';
    grid.append(button); toggles.set(id, button);
  }
  for (const [id, name, symbol] of ACTIONS) {
    const button = doc.createElement('button');
    button.type = 'button'; button.dataset.control = id;
    button.innerHTML = icon(symbol) + '<span>' + name + '</span>';
    if (id === 'pipBtn') {
      button.setAttribute('aria-label', 'Floating cameras');
      button.setAttribute('aria-describedby', 'menu-pip-hint');
      button.innerHTML += '<small class="player-menu-action-hint" id="menu-pip-hint"></small>';
    }
    actions.append(button);
  }
  pop.replaceChildren(grid, actions);
  return {
    update(state) {
      for (const [id, value] of Object.entries(playerMenuState(state))) {
        const button = toggles.get(id);
        button.setAttribute('aria-pressed', String(value.on));
        button.querySelector('use').setAttribute('href', '#i-' + value.icon);
        button.querySelector('.player-menu-state').textContent = value.status || (value.on ? 'On' : 'Off');
        button.querySelector('.player-menu-detail').textContent = value.detail;
      }
      const pip = actions.querySelector('[data-control="pipBtn"]');
      pip.disabled = !state.canPip;
      pip.querySelector('.player-menu-action-hint').textContent = state.canPip ? '' : 'Desktop only';
      pip.title = state.canPip ? 'Keep cameras above other windows' : 'Floating cameras need a supported desktop browser';
      pip.querySelector('span').textContent = state.pip ? 'Return cameras to player' : 'Floating cameras';
    },
  };
}
