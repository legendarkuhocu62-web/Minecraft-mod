const PEER_PREFIX = 'cobrowser_v1_';

// Если позже подключишь свой прокси-шлюз с RU IP, впиши его адрес сюда (например, 'https://ru-proxy.example.com/proxy?url=')
const RU_PROXY_PREFIX = '';

let currentUser = JSON.parse(localStorage.getItem('cobrowser_user')) || null;
let avatarSeed = currentUser?.seed || Math.random().toString(36).substring(7);
let pendingAvatarDataUrl = currentUser?.avatar || null;

let peer = null;
let connections = new Map();
let hostConn = null;

let roomState = {
  id: null,
  hostPeerId: null,
  controllerPeerId: null,
  ruMode: false,
  mode: 'search', // 'search' | 'frame'
  query: '',
  browserUrl: '',
  users: []
};

const screens = {
  profile: document.getElementById('profile-screen'),
  lobby: document.getElementById('lobby-screen'),
  room: document.getElementById('room-screen')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function isHost() {
  return peer && roomState.hostPeerId === peer.id;
}

function hasControl() {
  return peer && roomState.controllerPeerId === peer.id;
}

// --- 1. ПРОФИЛЬ И ОБРЕЗКА АВАТАРКИ В КРУЖОЧЕК ---
const avatarImg = document.getElementById('avatar-img');
const usernameInput = document.getElementById('username-input');
const customAvatarInput = document.getElementById('custom-avatar-input');
const cropModal = document.getElementById('crop-modal');
const cropImage = document.getElementById('crop-image');
const cropZoom = document.getElementById('crop-zoom');
const cropX = document.getElementById('crop-x');
const cropY = document.getElementById('crop-y');
const cropZoomVal = document.getElementById('crop-zoom-val');

function getGeneratedAvatarUrl(seed) {
  return `https://api.dicebear.com/7.x/bottts/svg?seed=${seed}`;
}

function updateAvatarPreview() {
  avatarImg.src = pendingAvatarDataUrl || getGeneratedAvatarUrl(avatarSeed);
}

document.getElementById('random-avatar-btn').onclick = () => {
  pendingAvatarDataUrl = null;
  avatarSeed = Math.random().toString(36).substring(7);
  updateAvatarPreview();
};

document.getElementById('custom-avatar-btn').onclick = () => {
  customAvatarInput.click();
};

function renderCropTransform() {
  const zoom = Number(cropZoom.value) / 100;
  const x = Number(cropX.value);
  const y = Number(cropY.value);
  cropZoomVal.textContent = `${cropZoom.value}%`;

  const natW = cropImage.naturalWidth || 220;
  const natH = cropImage.naturalHeight || 220;
  const baseScale = Math.max(220 / natW, 220 / natH);
  const totalScale = baseScale * zoom;

  cropImage.style.width = `${natW}px`;
  cropImage.style.height = `${natH}px`;
  cropImage.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${totalScale})`;
}

customAvatarInput.onchange = (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    cropImage.onload = () => {
      cropZoom.value = 100;
      cropX.value = 0;
      cropY.value = 0;
      renderCropTransform();
      cropModal.classList.remove('hidden');
    };
    cropImage.src = event.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
};

cropZoom.oninput = renderCropTransform;
cropX.oninput = renderCropTransform;
cropY.oninput = renderCropTransform;

document.getElementById('cancel-crop-btn').onclick = () => {
  cropModal.classList.add('hidden');
};

document.getElementById('apply-crop-btn').onclick = () => {
  const size = 180;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  const natW = cropImage.naturalWidth || size;
  const natH = cropImage.naturalHeight || size;
  const baseScale = Math.max(220 / natW, 220 / natH);
  const zoom = Number(cropZoom.value) / 100;
  const scaleRatio = (baseScale * zoom) * (size / 220);

  const offsetX = Number(cropX.value) * (size / 220);
  const offsetY = Number(cropY.value) * (size / 220);

  const drawW = natW * scaleRatio;
  const drawH = natH * scaleRatio;
  const drawX = (size - drawW) / 2 + offsetX;
  const drawY = (size - drawH) / 2 + offsetY;

  ctx.drawImage(cropImage, drawX, drawY, drawW, drawH);
  ctx.restore();

  pendingAvatarDataUrl = canvas.toDataURL('image/png');
  updateAvatarPreview();
  cropModal.classList.add('hidden');
};

document.getElementById('save-profile-btn').onclick = () => {
  const name = usernameInput.value.trim();
  if (!name) return alert('Введи никнейм!');
  const finalAvatar = pendingAvatarDataUrl || getGeneratedAvatarUrl(avatarSeed);

  currentUser = {
    id: currentUser?.id || 'u_' + Date.now(),
    name,
    seed: avatarSeed,
    avatar: finalAvatar
  };
  localStorage.setItem('cobrowser_user', JSON.stringify(currentUser));
  openLobby();
};

document.getElementById('edit-profile-btn').onclick = () => {
  usernameInput.value = currentUser.name;
  avatarSeed = currentUser.seed || avatarSeed;
  pendingAvatarDataUrl = currentUser.avatar?.startsWith('data:image') ? currentUser.avatar : null;
  updateAvatarPreview();
  showScreen('profile');
};

function openLobby() {
  document.getElementById('lobby-avatar').src = currentUser.avatar;
  document.getElementById('lobby-username').textContent = currentUser.name;

  const urlParams = new URLSearchParams(window.location.search);
  const inviteRoom = urlParams.get('room');
  if (inviteRoom) {
    startRoom(inviteRoom.toUpperCase(), false);
  } else {
    showScreen('lobby');
  }
}

// --- 2. КОМНАТЫ И ПРАВА "КТО ГЛАВНЫЙ" ---
document.getElementById('create-room-btn').onclick = () => {
  const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  startRoom(roomId, true);
};

document.getElementById('join-room-btn').onclick = () => {
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!code) return alert('Введи код комнаты!');
  startRoom(code, false);
};

function startRoom(roomId, createAsHost) {
  if (peer) peer.destroy();
  connections.clear();
  hostConn = null;

  roomState.id = roomId;
  const newUrl = `${window.location.pathname}?room=${roomId}`;
  window.history.pushState({}, '', newUrl);
  document.getElementById('current-room-id').textContent = roomId;
  showScreen('room');

  const desiredId = createAsHost ? `${PEER_PREFIX}${roomId}` : undefined;
  peer = new Peer(desiredId);

  peer.on('open', (myPeerId) => {
    const me = { peerId: myPeerId, name: currentUser.name, avatar: currentUser.avatar };

    if (createAsHost) {
      roomState.hostPeerId = myPeerId;
      roomState.controllerPeerId = myPeerId;
      roomState.users = [me];
      updateUI();
      addSystemMessage('Комната создана. Вы — Главный (👑).');
    } else {
      const hostPeerId = `${PEER_PREFIX}${roomId}`;
      hostConn = peer.connect(hostPeerId);

      hostConn.on('open', () => {
        hostConn.send({ type: 'join', user: me });
        addSystemMessage(`Подключились к комнате ${roomId}`);
      });

      hostConn.on('data', (msg) => handleMessageFromHost(msg));
      hostConn.on('close', () => addSystemMessage('Связь с Главным разорвана'));
    }
  });

  peer.on('connection', (conn) => {
    if (!isHost()) return;

    conn.on('open', () => {
      connections.set(conn.peer, conn);
    });

    conn.on('data', (msg) => handleMessageAtHost(conn.peer, msg));

    conn.on('close', () => {
      connections.delete(conn.peer);
      const removed = roomState.users.find(u => u.peerId === conn.peer);
      roomState.users = roomState.users.filter(u => u.peerId !== conn.peer);
      if (roomState.controllerPeerId === conn.peer) {
        roomState.controllerPeerId = roomState.hostPeerId;
      }
      if (removed) addSystemMessage(`${removed.name} вышел из комнаты`);
      broadcastState();
      updateUI();
    });
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      alert('Комната с таким кодом уже существует, входим как участник...');
      startRoom(roomId, false);
    } else if (err.type === 'peer-unavailable') {
      alert('Комната не найдена или Главный ещё не в сети.');
    } else {
      console.error(err);
    }
  });
}

function getSenderMeta() {
  const myPeerId = peer?.id || 'local';
  return {
    peerId: myPeerId,
    name: currentUser.name,
    avatar: currentUser.avatar,
    isHost: Boolean(isHost())
  };
}

function handleMessageAtHost(fromPeerId, msg) {
  if (msg.type === 'join') {
    const exists = roomState.users.some(u => u.peerId === msg.user.peerId);
    if (!exists) roomState.users.push(msg.user);
    addSystemMessage(`${msg.user.name} вошёл в комнату`);
    broadcastState();
    updateUI();
  } else if (msg.type === 'chat') {
    const senderObj = {
      ...msg.sender,
      isHost: msg.sender?.peerId === roomState.hostPeerId
    };
    const payload = { type: 'chat', sender: senderObj, text: msg.text };
    broadcastRaw(payload);
    appendChatMessage(senderObj, msg.text);
  } else if (msg.type === 'nav' && fromPeerId === roomState.controllerPeerId) {
    roomState.mode = msg.mode;
    roomState.query = msg.query || '';
    roomState.browserUrl = msg.url || '';
    if (typeof msg.ruMode === 'boolean') roomState.ruMode = msg.ruMode;
    broadcastState();
    updateUI();
  } else if (msg.type === 'ru-mode' && fromPeerId === roomState.controllerPeerId) {
    roomState.ruMode = Boolean(msg.ruMode);
    broadcastState();
    updateUI();
  }
}

function handleMessageFromHost(msg) {
  if (msg.type === 'state') {
    roomState = msg.state;
    updateUI();
  } else if (msg.type === 'chat') {
    appendChatMessage(msg.sender, msg.text);
  } else if (msg.type === 'system') {
    addSystemMessage(msg.text);
  }
}

function broadcastRaw(payload) {
  connections.forEach(conn => {
    if (conn.open) conn.send(payload);
  });
}

function broadcastState() {
  broadcastRaw({ type: 'state', state: roomState });
}

function setController(targetPeerId) {
  if (!isHost()) return;
  roomState.controllerPeerId = targetPeerId;
  const targetUser = roomState.users.find(u => u.peerId === targetPeerId);
  const sysMsg = { type: 'system', text: `Пульт управления теперь у: ${targetUser?.name || 'участника'}` };
  broadcastRaw(sysMsg);
  addSystemMessage(sysMsg.text);
  broadcastState();
  updateUI();
}

// --- РЕЖИМ 🇷🇺 ДЛЯ РОССИИ ---
const ruToggleBtn = document.getElementById('ru-toggle-btn');
const googleHint = document.getElementById('google-hint');

function setRuMode(enabled) {
  const nextVal = Boolean(enabled);
  if (isHost()) {
    roomState.ruMode = nextVal;
    const sysMsg = {
      type: 'system',
      text: nextVal
        ? '🇷🇺 Режим «Для России» включён — приоритет российских сайтов и сериалов'
        : 'Режим «Для России» выключен'
    };
    broadcastRaw(sysMsg);
    addSystemMessage(sysMsg.text);
    broadcastState();
    updateUI();
  } else if (hasControl() && hostConn && hostConn.open) {
    hostConn.send({ type: 'ru-mode', ruMode: nextVal });
  }
}

ruToggleBtn.onclick = () => {
  if (!isHost() && !hasControl()) return;
  setRuMode(!roomState.ruMode);
};

function updateRuModeUI() {
  const active = Boolean(roomState.ruMode);
  ruToggleBtn.classList.toggle('active', active);
  ruToggleBtn.setAttribute('aria-pressed', String(active));
  ruToggleBtn.textContent = active ? 'Вкл' : 'Выкл';
  ruToggleBtn.disabled = !(isHost() || hasControl());

  googleHint.textContent = active
    ? '🇷🇺 Режим для России активен: ищем российские сайты и сериалы без VPN-ограничений'
    : 'Введи поисковый запрос, название сериала или ссылку на сайт';
}

function updateUI() {
  const badge = document.getElementById('role-badge');
  const shield = document.getElementById('viewer-shield');
  const browserControls = document.querySelector('.browser-connect');

  if (isHost()) {
    badge.textContent = '👑 Вы Главный';
  } else if (hasControl()) {
    badge.textContent = '🎮 У вас пульт';
  } else {
    badge.textContent = '👀 Зритель';
  }

  browserControls.style.display = (isHost() || hasControl()) ? 'flex' : 'none';

  if (hasControl()) {
    shield.classList.add('hidden');
  } else {
    shield.classList.remove('hidden');
  }

  updateRuModeUI();
  applyBrowserState();
  renderUsers();
}

function renderUsers() {
  const list = document.getElementById('users-list');
  document.getElementById('users-count').textContent = roomState.users.length || 1;
  list.innerHTML = '';

  const usersToRender = roomState.users.length ? roomState.users : [{
    peerId: peer?.id || 'local',
    name: currentUser.name,
    avatar: currentUser.avatar
  }];

  usersToRender.forEach(u => {
    const li = document.createElement('li');
    li.className = 'user-item';

    const isUserHost = u.peerId === roomState.hostPeerId;
    const isUserCtrl = u.peerId === roomState.controllerPeerId;

    const img = document.createElement('img');
    img.src = u.avatar;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = `${u.name} ${isUserHost ? '👑' : ''} ${isUserCtrl ? '🎮' : ''}`;

    li.appendChild(img);
    li.appendChild(nameSpan);

    if (isHost()) {
      const btn = document.createElement('button');
      btn.className = `control-btn ${isUserCtrl ? 'active-ctrl' : ''}`;
      if (isUserCtrl && u.peerId !== peer.id) {
        btn.textContent = 'Забрать';
        btn.onclick = () => setController(peer.id);
      } else if (!isUserCtrl) {
        btn.textContent = 'Пульт';
        btn.onclick = () => setController(u.peerId);
      }
      if (btn.textContent) li.appendChild(btn);
    }

    list.appendChild(li);
  });
}

document.getElementById('copy-invite-btn').onclick = () => {
  navigator.clipboard.writeText(window.location.href).then(() => {
    alert('Ссылка скопирована! Кидай другу.');
  });
};

// --- 3. ПОИСК И ОТКРЫВАТЕЛЬ САЙТОВ ---
const iframe = document.getElementById('virtual-browser-frame');
const googleLauncher = document.getElementById('google-launcher');
const topInput = document.getElementById('neko-url-input');
const googleQueryInput = document.getElementById('google-query-input');
const searchResultsEl = document.getElementById('search-results');

function isDirectUrl(raw) {
  const s = (raw || '').trim();
  if (!s) return false;
  return /^https?:\/\//i.test(s) || (!s.includes(' ') && /^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(s));
}

function toFullUrl(raw) {
  const s = (raw || '').trim();
  const base = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  if (roomState.ruMode && RU_PROXY_PREFIX) {
    return RU_PROXY_PREFIX + encodeURIComponent(base);
  }
  return base;
}

function renderGoogleResults(query) {
  searchResultsEl.innerHTML = '';
  const q = (query || '').trim();
  if (!q) return;

  const ruSuffix = roomState.ruMode ? ' смотреть онлайн сериал' : '';
  const encoded = encodeURIComponent(q + ruSuffix);

  const items = roomState.ruMode
    ? [
        {
          title: `🇷🇺 Сериалы и сайты РФ: «${q}»`,
          url: `https://www.google.com/search?q=${encoded}&gl=ru&hl=ru`
        },
        {
          title: `🇷🇺 Поиск в Яндексе: «${q} сериал»`,
          url: `https://ya.ru/search/?text=${encodeURIComponent(q + ' сериал смотреть онлайн')}`
        },
        {
          title: `🇷🇺 Видео по запросу: «${q}»`,
          url: `https://www.google.com/search?tbm=vid&q=${encoded}&gl=ru&hl=ru`
        }
      ]
    : [
        {
          title: `Google Поиск: «${q}»`,
          url: `https://www.google.com/search?q=${encodeURIComponent(q)}`
        },
        {
          title: `Google Картинки: «${q}»`,
          url: `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`
        },
        {
          title: `Google Видео: «${q}»`,
          url: `https://www.google.com/search?tbm=vid&q=${encodeURIComponent(q)}`
        }
      ];

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'result-card';

    const titleEl = document.createElement('div');
    titleEl.className = 'r-title';
    titleEl.textContent = item.title;

    const urlEl = document.createElement('div');
    urlEl.className = 'r-url';
    urlEl.textContent = item.url;

    const actions = document.createElement('div');
    actions.className = 'r-actions';

    const openTabBtn = document.createElement('button');
    openTabBtn.type = 'button';
    openTabBtn.className = 'btn-primary btn-small';
    openTabBtn.textContent = 'Открыть';
    openTabBtn.onclick = () => {
      window.open(item.url, '_blank', 'noopener,noreferrer');
    };

    actions.appendChild(openTabBtn);
    card.appendChild(titleEl);
    card.appendChild(urlEl);
    card.appendChild(actions);
    searchResultsEl.appendChild(card);
  });
}

function applyBrowserState() {
  if (roomState.mode === 'frame' && roomState.browserUrl) {
    googleLauncher.classList.add('hidden');
    iframe.classList.remove('hidden');
    if (iframe.src !== roomState.browserUrl) {
      iframe.src = roomState.browserUrl;
    }
  } else {
    iframe.classList.add('hidden');
    googleLauncher.classList.remove('hidden');
    if (roomState.query) {
      googleQueryInput.value = roomState.query;
      topInput.value = roomState.query;
      renderGoogleResults(roomState.query);
    } else {
      searchResultsEl.innerHTML = '';
    }
  }
}

function sendNavigation(nextState) {
  if (isHost()) {
    roomState = { ...roomState, ...nextState };
    applyBrowserState();
    broadcastState();
  } else if (hasControl() && hostConn && hostConn.open) {
    hostConn.send({ type: 'nav', ...nextState });
  }
}

function handleSearchOrOpen(rawValue) {
  const val = (rawValue || '').trim();
  if (!val) {
    sendNavigation({ mode: 'search', query: '', browserUrl: '' });
    return;
  }

  if (isDirectUrl(val)) {
    const url = toFullUrl(val);
    sendNavigation({ mode: 'frame', query: val, browserUrl: url });
  } else {
    sendNavigation({ mode: 'search', query: val, browserUrl: '' });
  }
}

document.getElementById('connect-browser-btn').onclick = () => {
  handleSearchOrOpen(topInput.value);
};

topInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleSearchOrOpen(topInput.value);
  }
});

document.getElementById('google-search-btn').onclick = () => {
  handleSearchOrOpen(googleQueryInput.value);
};

googleQueryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleSearchOrOpen(googleQueryInput.value);
  }
});

document.getElementById('external-open-btn').onclick = () => {
  const q = (topInput.value || googleQueryInput.value || roomState.query || '').trim();
  const target = roomState.browserUrl
    ? roomState.browserUrl
    : (q ? `https://www.google.com/search?q=${encodeURIComponent(q)}` : 'https://www.google.com');
  window.open(target, '_blank', 'noopener,noreferrer');
};

// --- 4. ЧАТ С АВАТАРКОЙ И КОРОНОЙ ГЛАВНОГО ---
const chatMessages = document.getElementById('chat-messages');

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<div class="msg-body"><em style="color:var(--muted)">${text}</em></div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendChatMessage(sender, text) {
  const div = document.createElement('div');
  div.className = 'msg';

  const senderObj = typeof sender === 'string'
    ? { name: sender, avatar: currentUser.avatar, isHost: Boolean(isHost()) }
    : sender;

  const img = document.createElement('img');
  img.className = 'msg-avatar';
  img.src = senderObj.avatar || currentUser.avatar;
  img.alt = senderObj.name || '';

  const body = document.createElement('div');
  body.className = 'msg-body';

  const authorRow = document.createElement('div');
  authorRow.className = 'msg-author';
  authorRow.textContent = senderObj.name || 'Участник';

  if (senderObj.isHost || senderObj.peerId === roomState.hostPeerId) {
    const crown = document.createElement('span');
    crown.className = 'msg-crown';
    crown.textContent = '👑';
    authorRow.appendChild(crown);
  }

  const textNode = document.createElement('div');
  textNode.textContent = text;

  body.appendChild(authorRow);
  body.appendChild(textNode);
  div.appendChild(img);
  div.appendChild(body);

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

document.getElementById('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  const senderMeta = getSenderMeta();

  if (isHost()) {
    broadcastRaw({ type: 'chat', sender: senderMeta, text });
    appendChatMessage(senderMeta, text);
  } else if (hostConn && hostConn.open) {
    hostConn.send({ type: 'chat', sender: senderMeta, text });
    appendChatMessage(senderMeta, text);
  } else {
    appendChatMessage(senderMeta, text);
  }
  input.value = '';
};

if (currentUser) {
  openLobby();
} else {
  updateAvatarPreview();
  showScreen('profile');
}

