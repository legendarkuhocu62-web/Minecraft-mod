const PEER_PREFIX = 'cobrowser_v1_';
const RU_PROXY_PREFIX = '';

let currentUser = JSON.parse(localStorage.getItem('cobrowser_user')) || null;
let friendsList = JSON.parse(localStorage.getItem('cobrowser_friends')) || [];
let avatarSeed = currentUser?.seed || Math.random().toString(36).substring(7);
let pendingAvatarDataUrl = currentUser?.avatar || null;
let pendingInviteRoom = null;

let peer = null;
let connections = new Map();
let hostConn = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let activeRoomId = null;
let activeCreateAsHost = false;

const DEFAULT_CROP = { left: 4, top: 18, width: 92, height: 42 };

let roomState = {
  id: null,
  hostPeerId: null,
  controllerPeerId: null,
  ruMode: false,
  videoFocus: false,
  cropApplied: false,
  cropRect: { ...DEFAULT_CROP },
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

const connStatusEl = document.getElementById('conn-status');

function setConnStatus(text, mode = 'ok') {
  if (!connStatusEl) return;
  connStatusEl.textContent = text;
  connStatusEl.classList.remove('warn', 'err');
  if (mode === 'warn') connStatusEl.classList.add('warn');
  if (mode === 'err') connStatusEl.classList.add('err');
}

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

function getMyUserId() {
  return currentUser?.id || peer?.id || '';
}

// --- ДРУЗЬЯ ---
function saveFriends() {
  localStorage.setItem('cobrowser_friends', JSON.stringify(friendsList));
  renderFriends();
  renderUsers();
}

function isFriend(userObj) {
  if (!userObj) return false;
  return friendsList.some(f =>
    (userObj.peerId && f.peerId === userObj.peerId) ||
    (userObj.userId && f.userId === userObj.userId) ||
    (userObj.name && f.name.toLowerCase() === userObj.name.toLowerCase())
  );
}

function addFriend(userObj) {
  if (!userObj) return;
  const rawName = (userObj.name || '').trim();
  const rawId = (userObj.userId || userObj.peerId || '').trim();
  if (!rawName && !rawId) return;
  if (rawId && (rawId === currentUser?.id || rawId === peer?.id)) return;
  if (isFriend(userObj)) return;

  const displayName = rawName || rawId;
  friendsList.push({
    userId: rawId,
    peerId: userObj.peerId || '',
    name: displayName,
    avatar: userObj.avatar || getGeneratedAvatarUrl(displayName),
    lastRoom: roomState.id || ''
  });
  saveFriends();
}

function removeFriend(index) {
  friendsList.splice(index, 1);
  saveFriends();
}

function renderFriends() {
  const listEl = document.getElementById('friends-list');
  const countEl = document.getElementById('friends-count');
  if (!listEl || !countEl) return;

  countEl.textContent = friendsList.length;
  listEl.innerHTML = '';

  if (!friendsList.length) {
    listEl.innerHTML = '<li class="friend-sub" style="padding:0.5rem">Друзей пока нет. Нажми «+ Друг» у участника в комнате или вбей ник/ID выше.</li>';
    return;
  }

  friendsList.forEach((f, idx) => {
    const li = document.createElement('li');
    li.className = 'friend-item';

    const img = document.createElement('img');
    img.src = f.avatar || getGeneratedAvatarUrl(f.name);
    img.alt = f.name;

    const meta = document.createElement('div');
    meta.className = 'friend-meta';

    const nameDiv = document.createElement('div');
    nameDiv.className = 'friend-name';
    nameDiv.textContent = f.name;

    const subDiv = document.createElement('div');
    subDiv.className = 'friend-sub';
    const idPart = f.userId ? `ID: ${f.userId}` : 'Без ID';
    const roomPart = f.lastRoom ? ` · Комната: ${f.lastRoom}` : '';
    subDiv.textContent = `${idPart}${roomPart}`;

    meta.appendChild(nameDiv);
    meta.appendChild(subDiv);

    const actions = document.createElement('div');
    actions.className = 'friend-actions';

    if (f.lastRoom) {
      const joinBtn = document.createElement('button');
      joinBtn.type = 'button';
      joinBtn.className = 'btn-primary btn-small';
      joinBtn.textContent = 'Войти';
      joinBtn.onclick = () => startRoom(f.lastRoom.toUpperCase(), false);
      actions.appendChild(joinBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-secondary btn-small';
    delBtn.textContent = '✕';
    delBtn.title = 'Удалить из друзей';
    delBtn.onclick = () => removeFriend(idx);
    actions.appendChild(delBtn);

    li.appendChild(img);
    li.appendChild(meta);
    li.appendChild(actions);
    listEl.appendChild(li);
  });
}

document.getElementById('tab-room-btn').onclick = () => {
  document.getElementById('tab-room-btn').classList.add('active');
  document.getElementById('tab-friends-btn').classList.remove('active');
  document.getElementById('lobby-tab-room').classList.add('active');
  document.getElementById('lobby-tab-friends').classList.remove('active');
};

document.getElementById('tab-friends-btn').onclick = () => {
  document.getElementById('tab-friends-btn').classList.add('active');
  document.getElementById('tab-room-btn').classList.remove('active');
  document.getElementById('lobby-tab-friends').classList.add('active');
  document.getElementById('lobby-tab-room').classList.remove('active');
  renderFriends();
};

document.getElementById('add-friend-manual-btn').onclick = () => {
  const input = document.getElementById('friend-name-input');
  const val = input.value.trim();
  if (!val) return;
  if (val.startsWith('u_')) {
    addFriend({ userId: val, name: val });
  } else {
    addFriend({ name: val });
  }
  input.value = '';
};

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
  return `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(seed || 'Guest')}`;
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
  if (!name) return alert('Введи свой никнейм!');
  const finalAvatar = pendingAvatarDataUrl || getGeneratedAvatarUrl(avatarSeed);

  currentUser = {
    id: currentUser?.id || ('u_' + Math.random().toString(36).substring(2, 8)),
    name,
    seed: avatarSeed,
    avatar: finalAvatar
  };
  localStorage.setItem('cobrowser_user', JSON.stringify(currentUser));

  if (pendingInviteRoom) {
    const roomToJoin = pendingInviteRoom;
    pendingInviteRoom = null;
    startRoom(roomToJoin, false);
  } else {
    openLobby();
  }
};

document.getElementById('edit-profile-btn').onclick = () => {
  usernameInput.value = currentUser.name;
  avatarSeed = currentUser.seed || avatarSeed;
  pendingAvatarDataUrl = currentUser.avatar?.startsWith('data:image') ? currentUser.avatar : null;
  updateAvatarPreview();
  showScreen('profile');
};

document.getElementById('copy-my-id-btn').onclick = () => {
  const myId = getMyUserId();
  if (!myId) return;
  navigator.clipboard.writeText(myId).then(() => {
    alert(`Твой ID скопирован: ${myId}`);
  });
};

function openLobby() {
  document.getElementById('lobby-avatar').src = currentUser.avatar;
  document.getElementById('lobby-username').textContent = currentUser.name;
  document.getElementById('lobby-user-id').textContent = getMyUserId();
  renderFriends();
  showScreen('lobby');
}

// --- ВЫХОД В ГЛАВНОЕ МЕНЮ ---
function exitToMainMenu() {
  clearRoomTimers();
  if (peer) {
    try { peer.destroy(); } catch (_) {}
    peer = null;
  }
  connections.clear();
  hostConn = null;
  activeRoomId = null;
  activeCreateAsHost = false;

  roomState = {
    id: null,
    hostPeerId: null,
    controllerPeerId: null,
    ruMode: false,
    videoFocus: false,
    cropApplied: false,
    cropRect: { ...DEFAULT_CROP },
    mode: 'search',
    query: '',
    browserUrl: '',
    users: []
  };

  window.history.pushState({}, '', window.location.pathname);
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('virtual-browser-frame').src = '';
  document.getElementById('virtual-browser-frame').classList.add('hidden');
  document.getElementById('google-launcher').classList.remove('hidden');

  openLobby();
}

document.getElementById('exit-to-menu-btn').onclick = exitToMainMenu;

// --- 2. КОМНАТЫ, АВТОПЕРЕПОДКЛЮЧЕНИЕ И ПРАВА "КТО ГЛАВНЫЙ" ---
document.getElementById('create-room-btn').onclick = () => {
  const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  startRoom(roomId, true);
};

document.getElementById('join-room-btn').onclick = () => {
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!code) return alert('Введи код комнаты!');
  startRoom(code, false);
};

function clearRoomTimers() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function connectGuestToHost(roomId) {
  if (!peer || peer.destroyed || !currentUser) return;
  const hostPeerId = `${PEER_PREFIX}${roomId}`;
  const me = {
    peerId: peer.id,
    userId: currentUser.id,
    name: currentUser.name,
    avatar: currentUser.avatar
  };

  try {
    if (hostConn && hostConn.open) return;
    hostConn = peer.connect(hostPeerId, { reliable: true });
    setConnStatus('● подключение...', 'warn');

    hostConn.on('open', () => {
      setConnStatus('● онлайн', 'ok');
      hostConn.send({ type: 'join', user: me });
      addSystemMessage(`Подключились к комнате ${roomId}`);
    });

    hostConn.on('data', (msg) => {
      if (msg?.type === 'ping') {
        if (hostConn.open) hostConn.send({ type: 'pong' });
        return;
      }
      handleMessageFromHost(msg);
    });

    hostConn.on('close', () => {
      setConnStatus('● переподключение...', 'warn');
      scheduleGuestReconnect(roomId);
    });

    hostConn.on('error', () => {
      setConnStatus('● ошибка связи', 'err');
      scheduleGuestReconnect(roomId);
    });
  } catch (e) {
    scheduleGuestReconnect(roomId);
  }
}

function scheduleGuestReconnect(roomId) {
  if (reconnectTimer || activeCreateAsHost || !activeRoomId) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (peer && !peer.destroyed && peer.disconnected) {
      try { peer.reconnect(); } catch (_) {}
    }
    connectGuestToHost(roomId);
  }, 2500);
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!peer || peer.destroyed) return;
    if (peer.disconnected) {
      setConnStatus('● переподключение...', 'warn');
      try { peer.reconnect(); } catch (_) {}
    }
    if (isHost()) {
      connections.forEach((conn) => {
        if (conn.open) {
          try { conn.send({ type: 'ping' }); } catch (_) {}
        }
      });
    } else if (hostConn) {
      if (hostConn.open) {
        try { hostConn.send({ type: 'ping' }); } catch (_) {}
      } else {
        connectGuestToHost(activeRoomId);
      }
    }
  }, 8000);
}

function startRoom(roomId, createAsHost) {
  clearRoomTimers();
  if (peer) {
    try { peer.destroy(); } catch (_) {}
  }
  connections.clear();
  hostConn = null;
  activeRoomId = roomId;
  activeCreateAsHost = createAsHost;

  roomState.id = roomId;
  const newUrl = `${window.location.pathname}?room=${roomId}`;
  window.history.pushState({}, '', newUrl);
  document.getElementById('current-room-id').textContent = roomId;
  setConnStatus('● подключение...', 'warn');
  showScreen('room');

  const desiredId = createAsHost ? `${PEER_PREFIX}${roomId}` : undefined;
  peer = new Peer(desiredId, {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    }
  });

  peer.on('open', (myPeerId) => {
    setConnStatus('● онлайн', 'ok');
    const me = {
      peerId: myPeerId,
      userId: currentUser.id,
      name: currentUser.name,
      avatar: currentUser.avatar
    };

    if (createAsHost) {
      roomState.hostPeerId = myPeerId;
      roomState.controllerPeerId = myPeerId;
      roomState.users = [me];
      updateUI();
      addSystemMessage('Комната создана. Вы — Главный (👑).');
    } else {
      connectGuestToHost(roomId);
    }
    startHeartbeat();
  });

  peer.on('disconnected', () => {
    setConnStatus('● переподключение...', 'warn');
    if (peer && !peer.destroyed) {
      setTimeout(() => {
        if (peer && !peer.destroyed && peer.disconnected) {
          try { peer.reconnect(); } catch (_) {}
        }
      }, 1500);
    }
  });

  peer.on('connection', (conn) => {
    if (!isHost()) return;

    conn.on('open', () => {
      connections.set(conn.peer, conn);
      conn.send({ type: 'state', state: roomState });
    });

    conn.on('data', (msg) => {
      if (msg?.type === 'ping' || msg?.type === 'pong') return;
      handleMessageAtHost(conn.peer, msg);
    });

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
      startRoom(roomId, false);
    } else if (err.type === 'peer-unavailable') {
      setConnStatus('● ждём хоста...', 'warn');
      if (!createAsHost) scheduleGuestReconnect(roomId);
    } else {
      setConnStatus('● сбой сети', 'err');
      console.error(err);
    }
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && peer && !peer.destroyed && activeRoomId) {
    if (peer.disconnected) {
      try { peer.reconnect(); } catch (_) {}
    }
    if (!activeCreateAsHost && (!hostConn || !hostConn.open)) {
      connectGuestToHost(activeRoomId);
    }
  }
});

function getSenderMeta() {
  const myPeerId = peer?.id || 'local';
  return {
    peerId: myPeerId,
    userId: currentUser.id,
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
    if (roomState.mode !== 'frame') {
      roomState.videoFocus = false;
      roomState.cropApplied = false;
    }
    broadcastState();
    updateUI();
  } else if (msg.type === 'ru-mode' && fromPeerId === roomState.controllerPeerId) {
    roomState.ruMode = Boolean(msg.ruMode);
    broadcastState();
    updateUI();
  } else if (msg.type === 'video-focus' && fromPeerId === roomState.controllerPeerId) {
    roomState = { ...roomState, ...msg };
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
    if (conn.open) {
      try { conn.send(payload); } catch (_) {}
    }
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
        ? '🇷🇺 Режим «Для России» включён — поиск в Google с регионом РФ'
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
    ? '🇷🇺 Режим для России включён — поиск в Google по РФ'
    : 'Введите запрос для поиска в Google или адрес сайта';
}

// --- РЕАЛЬНОЕ СРЕЗАНИЕ ПО РАМКЕ ---
const workspaceEl = document.getElementById('workspace');
const browserBox = document.getElementById('browser-container');
const siteViewActions = document.getElementById('site-view-actions');
const videoFocusBtn = document.getElementById('video-focus-btn');
const expandBrowserBtn = document.getElementById('expand-browser-btn');
const exitExpandBtn = document.getElementById('exit-expand-btn');
const focusHeaderStrip = document.getElementById('focus-header-strip');
const focusStatusText = document.getElementById('focus-status-text');
const applyCropCutBtn = document.getElementById('apply-crop-cut-btn');
const editCropFrameBtn = document.getElementById('edit-crop-frame-btn');
const cropOverlay = document.getElementById('crop-overlay');
const cropBox = document.getElementById('crop-box');
const iframeStage = document.getElementById('iframe-stage');

function isSiteOpened() {
  return roomState.mode === 'frame' && Boolean(roomState.browserUrl);
}

function syncVideoFocusPayload(patch) {
  if (isHost()) {
    roomState = { ...roomState, ...patch };
    applyVideoFocusUI();
    broadcastState();
  } else if (hasControl() && hostConn && hostConn.open) {
    hostConn.send({ type: 'video-focus', ...patch });
  } else {
    roomState = { ...roomState, ...patch };
    applyVideoFocusUI();
  }
}

videoFocusBtn.onclick = () => {
  if (!isSiteOpened()) return;
  if (!roomState.videoFocus) {
    syncVideoFocusPayload({
      videoFocus: true,
      cropApplied: false,
      cropRect: roomState.cropRect || { ...DEFAULT_CROP }
    });
  } else {
    syncVideoFocusPayload({
      videoFocus: false,
      cropApplied: false
    });
  }
};

applyCropCutBtn.onclick = () => {
  if (!isSiteOpened()) return;
  syncVideoFocusPayload({
    videoFocus: true,
    cropApplied: true,
    cropRect: roomState.cropRect || { ...DEFAULT_CROP }
  });
};

editCropFrameBtn.onclick = () => {
  if (!isSiteOpened()) return;
  syncVideoFocusPayload({
    videoFocus: true,
    cropApplied: false
  });
};

document.getElementById('reset-crop-btn').onclick = () => {
  syncVideoFocusPayload({
    videoFocus: true,
    cropApplied: false,
    cropRect: { ...DEFAULT_CROP }
  });
};

function renderCropBoxStyle() {
  const rect = roomState.cropRect || DEFAULT_CROP;
  cropBox.style.left = `${rect.left}%`;
  cropBox.style.top = `${rect.top}%`;
  cropBox.style.width = `${rect.width}%`;
  cropBox.style.height = `${rect.height}%`;
}

let dragInfo = null;

cropOverlay.addEventListener('pointerdown', (e) => {
  const handle = e.target.dataset?.handle;
  if (!handle || !roomState.videoFocus || roomState.cropApplied) return;
  e.preventDefault();
  const overlayRect = cropOverlay.getBoundingClientRect();
  dragInfo = {
    handle,
    startX: e.clientX,
    startY: e.clientY,
    overlayW: overlayRect.width || 1,
    overlayH: overlayRect.height || 1,
    startRect: { ...(roomState.cropRect || DEFAULT_CROP) }
  };
  e.target.setPointerCapture?.(e.pointerId);
});

window.addEventListener('pointermove', (e) => {
  if (!dragInfo) return;
  const dxPct = ((e.clientX - dragInfo.startX) / dragInfo.overlayW) * 100;
  const dyPct = ((e.clientY - dragInfo.startY) / dragInfo.overlayH) * 100;
  let { left, top, width, height } = dragInfo.startRect;
  const h = dragInfo.handle;

  if (h.includes('l')) {
    const newLeft = Math.max(0, Math.min(left + width - 12, left + dxPct));
    width = left + width - newLeft;
    left = newLeft;
  }
  if (h.includes('r')) {
    width = Math.max(12, Math.min(100 - left, width + dxPct));
  }
  if (h.includes('t')) {
    const newTop = Math.max(0, Math.min(top + height - 12, top + dyPct));
    height = top + height - newTop;
    top = newTop;
  }
  if (h.includes('b')) {
    height = Math.max(12, Math.min(100 - top, height + dyPct));
  }

  roomState.cropRect = { left, top, width, height };
  renderCropBoxStyle();
});

window.addEventListener('pointerup', () => {
  if (!dragInfo) return;
  dragInfo = null;
  syncVideoFocusPayload({ cropRect: roomState.cropRect });
});

function applyStageCutTransform() {
  const opened = isSiteOpened();
  const active = Boolean(roomState.videoFocus) && opened;
  const cut = active && Boolean(roomState.cropApplied);

  if (!cut) {
    iframeStage.style.width = '100%';
    iframeStage.style.height = '100%';
    iframeStage.style.transform = 'none';
    return;
  }

  const rect = roomState.cropRect || DEFAULT_CROP;
  const wPct = Math.max(12, rect.width) / 100;
  const hPct = Math.max(12, rect.height) / 100;
  const scaleX = 1 / wPct;
  const scaleY = 1 / hPct;
  const scale = Math.min(scaleX, scaleY);

  const offsetX = -(rect.left / 100) * 100 * scale;
  const offsetY = -(rect.top / 100) * 100 * scale;

  iframeStage.style.width = '100%';
  iframeStage.style.height = '100%';
  iframeStage.style.transformOrigin = 'top left';
  iframeStage.style.transform = `translate(${offsetX}%, ${offsetY}%) scale(${scale})`;
}

function applyVideoFocusUI() {
  const opened = isSiteOpened();
  siteViewActions.classList.toggle('hidden', !opened);

  if (!opened) {
    roomState.videoFocus = false;
    roomState.cropApplied = false;
  }
  if (!opened && browserBox.classList.contains('expanded')) {
    browserBox.classList.remove('expanded');
    exitExpandBtn.classList.add('hidden');
  }

  const active = Boolean(roomState.videoFocus) && opened;
  const cut = active && Boolean(roomState.cropApplied);

  workspaceEl.classList.toggle('video-focus', active);
  videoFocusBtn.classList.toggle('active-focus', active);
  videoFocusBtn.textContent = active ? 'Обычный вид' : '✂ Обрезать кадр';
  focusHeaderStrip.classList.toggle('hidden', !active);

  cropOverlay.classList.toggle('hidden', !active || cut);
  applyCropCutBtn.classList.toggle('hidden', cut);
  editCropFrameBtn.classList.toggle('hidden', !cut);

  focusStatusText.textContent = cut
    ? 'Лишнее срезано по рамке'
    : 'Потяни рамку за углы/края и нажми «Срезать по рамке»';

  renderCropBoxStyle();
  applyStageCutTransform();
}

expandBrowserBtn.onclick = () => {
  if (!isSiteOpened()) return;
  browserBox.classList.add('expanded');
  exitExpandBtn.classList.remove('hidden');
};

exitExpandBtn.onclick = () => {
  browserBox.classList.remove('expanded');
  exitExpandBtn.classList.add('hidden');
};

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

  const framingNow = Boolean(roomState.videoFocus) && !roomState.cropApplied;
  if (hasControl() || framingNow) {
    shield.classList.add('hidden');
  } else {
    shield.classList.remove('hidden');
  }

  updateRuModeUI();
  applyBrowserState();
  applyVideoFocusUI();
  renderUsers();
}

function renderUsers() {
  const list = document.getElementById('users-list');
  document.getElementById('users-count').textContent = roomState.users.length || 1;
  list.innerHTML = '';

  const usersToRender = roomState.users.length ? roomState.users : [{
    peerId: peer?.id || 'local',
    userId: currentUser?.id || '',
    name: currentUser?.name || 'Участник',
    avatar: currentUser?.avatar || getGeneratedAvatarUrl('Guest')
  }];

  usersToRender.forEach(u => {
    const li = document.createElement('li');
    li.className = 'user-item';

    const isUserHost = u.peerId === roomState.hostPeerId;
    const isUserCtrl = u.peerId === roomState.controllerPeerId;
    const isSelf = (peer && u.peerId === peer.id) || (currentUser && u.userId === currentUser.id);

    const img = document.createElement('img');
    img.src = u.avatar;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = `${u.name} ${isUserHost ? '👑' : ''} ${isUserCtrl ? '🎮' : ''}`;
    nameSpan.title = u.userId ? `ID: ${u.userId}` : u.name;

    li.appendChild(img);
    li.appendChild(nameSpan);

    const actions = document.createElement('div');
    actions.className = 'user-actions';

    if (!isSelf) {
      const friendBtn = document.createElement('button');
      friendBtn.type = 'button';
      const alreadyFriend = isFriend(u);
      friendBtn.className = `friend-add-btn ${alreadyFriend ? 'added' : ''}`;
      friendBtn.textContent = alreadyFriend ? '✓ Друг' : '+ Друг';
      friendBtn.disabled = alreadyFriend;
      friendBtn.onclick = () => addFriend(u);
      actions.appendChild(friendBtn);
    }

    if (isHost()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `control-btn ${isUserCtrl ? 'active-ctrl' : ''}`;
      if (isUserCtrl && u.peerId !== peer.id) {
        btn.textContent = 'Забрать';
        btn.onclick = () => setController(peer.id);
      } else if (!isUserCtrl) {
        btn.textContent = 'Пульт';
        btn.onclick = () => setController(u.peerId);
      }
      if (btn.textContent) actions.appendChild(btn);
    }

    if (actions.children.length) li.appendChild(actions);
    list.appendChild(li);
  });
}

document.getElementById('copy-invite-btn').onclick = () => {
  navigator.clipboard.writeText(window.location.href).then(() => {
    alert('Ссылка скопирована! Кидай другу.');
  });
};

// --- 3. ПОИСК GOOGLE И ОТКРЫВАТЕЛЬ САЙТОВ ---
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

function buildGoogleSearchUrl(query, extraParam = '') {
  const q = encodeURIComponent((query || '').trim());
  const ruParams = roomState.ruMode ? '&gl=ru&hl=ru' : '';
  return `https://www.google.com/search?q=${q}${extraParam}${ruParams}`;
}

function renderGoogleResults(query) {
  searchResultsEl.innerHTML = '';
  const q = (query || '').trim();
  if (!q) return;

  const items = [
    {
      title: `Найти в Google: «${q}»`,
      url: buildGoogleSearchUrl(q)
    },
    {
      title: `Картинки в Google: «${q}»`,
      url: buildGoogleSearchUrl(q, '&tbm=isch')
    },
    {
      title: `Видео в Google: «${q}»`,
      url: buildGoogleSearchUrl(q, '&tbm=vid')
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
    openTabBtn.textContent = 'Найти в Google';
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
    applyVideoFocusUI();
    broadcastState();
  } else if (hasControl() && hostConn && hostConn.open) {
    hostConn.send({ type: 'nav', ...nextState });
  }
}

function handleSearchOrOpen(rawValue, openGoogleImmediately = false) {
  const val = (rawValue || '').trim();
  if (!val) {
    sendNavigation({ mode: 'search', query: '', browserUrl: '', videoFocus: false, cropApplied: false });
    return;
  }

  if (isDirectUrl(val)) {
    const url = toFullUrl(val);
    sendNavigation({ mode: 'frame', query: val, browserUrl: url, videoFocus: false, cropApplied: false });
  } else {
    sendNavigation({ mode: 'search', query: val, browserUrl: '', videoFocus: false, cropApplied: false });
    if (openGoogleImmediately) {
      window.open(buildGoogleSearchUrl(val), '_blank', 'noopener,noreferrer');
    }
  }
}

document.getElementById('connect-browser-btn').onclick = () => {
  handleSearchOrOpen(topInput.value, true);
};

topInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleSearchOrOpen(topInput.value, true);
  }
});

document.getElementById('google-search-btn').onclick = () => {
  handleSearchOrOpen(googleQueryInput.value, true);
};

googleQueryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleSearchOrOpen(googleQueryInput.value, true);
  }
});

document.getElementById('external-open-btn').onclick = () => {
  const q = (topInput.value || googleQueryInput.value || roomState.query || '').trim();
  const target = roomState.browserUrl
    ? roomState.browserUrl
    : (q ? buildGoogleSearchUrl(q) : 'https://www.google.com');
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

const inviteRoomFromUrl = new URLSearchParams(window.location.search).get('room');

if (currentUser && currentUser.name) {
  if (inviteRoomFromUrl) {
    startRoom(inviteRoomFromUrl.toUpperCase(), false);
  } else {
    openLobby();
  }
} else {
  pendingInviteRoom = inviteRoomFromUrl ? inviteRoomFromUrl.toUpperCase() : null;
  updateAvatarPreview();
  showScreen('profile');
}
