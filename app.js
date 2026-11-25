const PEER_PREFIX = 'cobrowser_v1_';
const RU_PROXY_PREFIX = '';
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.moomoo.me'
];
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://yewtu.be',
  'https://invidious.nerdvpn.de'
];

let currentUser = JSON.parse(localStorage.getItem('cobrowser_user')) || null;
let friendsList = JSON.parse(localStorage.getItem('cobrowser_friends')) || [];
let friendRequests = JSON.parse(localStorage.getItem('cobrowser_friend_requests')) || [];
let outgoingRequests = JSON.parse(localStorage.getItem('cobrowser_outgoing_requests')) || [];

let avatarSeed = currentUser?.seed || Math.random().toString(36).substring(7);
let pendingAvatarDataUrl = currentUser?.avatar || null;
let pendingInviteRoom = null;

let peer = null;
let connections = new Map();
let hostConn = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let activeRoomId = null;
if (typeof cbTrackPresence === 'function') setTimeout(cbTrackPresence, 250);
let activeCreateAsHost = false;
let lastSearchedQuery = '';

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

function canControlRoom() {
  return Boolean(isHost() || hasControl());
}

function getMyUserId() {
  return currentUser?.id || peer?.id || '';
}

function getGeneratedAvatarUrl(seed) {
  return `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(seed || 'Guest')}`;
}

function getValidAvatar(avatar, fallbackSeed) {
  if (typeof avatar === 'string' && avatar.trim().length > 0) {
    return avatar.trim();
  }
  return getGeneratedAvatarUrl(fallbackSeed || 'Guest');
}

// --- ДРУЗЬЯ И ЗАЯВКИ В ДРУЗЬЯ ---
function persistFriendsData() {
  localStorage.setItem('cobrowser_friends', JSON.stringify(friendsList));
  localStorage.setItem('cobrowser_friend_requests', JSON.stringify(friendRequests));
  localStorage.setItem('cobrowser_outgoing_requests', JSON.stringify(outgoingRequests));
  renderFriends();
  renderFriendRequests();
  renderUsers();
}

function isFriend(userObj) {
  if (!userObj) return false;
  return friendsList.some(f =>
    (userObj.userId && f.userId && f.userId === userObj.userId) ||
    (userObj.peerId && f.peerId && f.peerId === userObj.peerId) ||
    (userObj.name && f.name && f.name.toLowerCase() === userObj.name.toLowerCase())
  );
}

function hasOutgoingRequest(userObj) {
  if (!userObj) return false;
  return outgoingRequests.some(r =>
    (userObj.userId && r.userId && r.userId === userObj.userId) ||
    (userObj.peerId && r.peerId && r.peerId === userObj.peerId) ||
    (userObj.name && r.name && r.name.toLowerCase() === userObj.name.toLowerCase())
  );
}

function upsertFriendRecord(record) {
  const realAvatar = getValidAvatar(record.avatar, record.name || record.userId);
  const existingIdx = friendsList.findIndex(f =>
    (record.userId && f.userId && f.userId === record.userId) ||
    (record.peerId && f.peerId && f.peerId === record.peerId) ||
    (record.name && f.name && f.name.toLowerCase() === record.name.toLowerCase())
  );

  const cleanEntry = {
    userId: record.userId || (existingIdx >= 0 ? friendsList[existingIdx].userId : ''),
    peerId: record.peerId || (existingIdx >= 0 ? friendsList[existingIdx].peerId : ''),
    name: (record.name || record.userId || 'Друг').trim(),
    avatar: realAvatar,
    lastRoom: record.lastRoom || roomState.id || (existingIdx >= 0 ? friendsList[existingIdx].lastRoom : '')
  };

  if (existingIdx >= 0) {
    friendsList[existingIdx] = { ...friendsList[existingIdx], ...cleanEntry };
  } else {
    friendsList.push(cleanEntry);
  }

  outgoingRequests = outgoingRequests.filter(r =>
    !(cleanEntry.userId && r.userId === cleanEntry.userId) &&
    !(cleanEntry.peerId && r.peerId === cleanEntry.peerId) &&
    !(cleanEntry.name && r.name.toLowerCase() === cleanEntry.name.toLowerCase())
  );

  persistFriendsData();
}

function sendDirectPeerMessage(targetPeerId, payload) {
  if (!peer || peer.destroyed || !targetPeerId || targetPeerId === peer.id) return false;
  const existingConn = connections.get(targetPeerId) || (hostConn && hostConn.peer === targetPeerId ? hostConn : null);
  if (existingConn && existingConn.open) {
    existingConn.send(payload);
    return true;
  }
  const c = peer.connect(targetPeerId, { reliable: true });
  c.on('open', () => {
    c.send(payload);
  });
  return true;
}

function sendFriendRequest(targetUser) {
  if (!targetUser || !currentUser) return;
  const targetId = (targetUser.userId || targetUser.peerId || '').trim();
  const targetName = (targetUser.name || targetUser.userId || '').trim();
  if (!targetId && !targetName) return;
  if (targetId && (targetId === currentUser.id || targetId === peer?.id)) return;
  if (isFriend(targetUser)) return;

  const myProfile = {
    userId: currentUser.id,
    peerId: peer?.id || '',
    name: currentUser.name,
    avatar: getValidAvatar(currentUser.avatar, currentUser.seed || currentUser.name),
    roomId: roomState.id || ''
  };

  if (!hasOutgoingRequest(targetUser)) {
    outgoingRequests.push({
      userId: targetUser.userId || '',
      peerId: targetUser.peerId || '',
      name: targetName
    });
  }

  const reqPayload = {
    type: 'friend-request',
    from: myProfile,
    toUserId: targetUser.userId || '',
    toPeerId: targetUser.peerId || ''
  };

  if (targetUser.peerId) {
    sendDirectPeerMessage(targetUser.peerId, reqPayload);
  }
  if (hostConn && hostConn.open) {
    hostConn.send(reqPayload);
  } else if (isHost()) {
    broadcastRaw(reqPayload);
  }

  persistFriendsData();
  alert(`Предложение в друзья отправлено пользователю ${targetName}`);
}

function handleIncomingFriendRequest(msg) {
  const from = msg.from;
  if (!from) return;
  if (from.userId && from.userId === currentUser?.id) return;
  if (isFriend(from)) return;

  const exists = friendRequests.some(r =>
    (from.userId && r.userId === from.userId) ||
    (from.peerId && r.peerId === from.peerId)
  );
  if (!exists) {
    friendRequests.push({
      userId: from.userId || '',
      peerId: from.peerId || '',
      name: from.name || 'Пользователь',
      avatar: getValidAvatar(from.avatar, from.name || from.userId),
      roomId: from.roomId || ''
    });
    persistFriendsData();
    addSystemMessage(`💌 Новое предложение в друзья от ${from.name}`);
  }
}

function acceptFriendRequest(index) {
  const req = friendRequests[index];
  if (!req) return;
  friendRequests.splice(index, 1);

  upsertFriendRecord({
    userId: req.userId,
    peerId: req.peerId,
    name: req.name,
    avatar: req.avatar,
    lastRoom: req.roomId || roomState.id || ''
  });

  const acceptPayload = {
    type: 'friend-accept',
    from: {
      userId: currentUser.id,
      peerId: peer?.id || '',
      name: currentUser.name,
      avatar: getValidAvatar(currentUser.avatar, currentUser.seed || currentUser.name),
      roomId: roomState.id || ''
    },
    toUserId: req.userId || '',
    toPeerId: req.peerId || ''
  };

  if (req.peerId) {
    sendDirectPeerMessage(req.peerId, acceptPayload);
  }
  if (hostConn && hostConn.open) {
    hostConn.send(acceptPayload);
  } else if (isHost()) {
    broadcastRaw(acceptPayload);
  }
}

function declineFriendRequest(index) {
  friendRequests.splice(index, 1);
  persistFriendsData();
}

function removeFriend(index) {
  friendsList.splice(index, 1);
  persistFriendsData();
}

function renderFriendRequests() {
  const listEl = document.getElementById('friend-requests-list');
  const countEl = document.getElementById('requests-count');
  const badgeEl = document.getElementById('friend-req-badge');
  if (!listEl || !countEl) return;

  countEl.textContent = friendRequests.length;
  if (badgeEl) {
    badgeEl.textContent = friendRequests.length;
    badgeEl.classList.toggle('hidden', friendRequests.length === 0);
  }

  listEl.innerHTML = '';
  if (!friendRequests.length) {
    listEl.innerHTML = '<li class="friend-sub" style="padding:0.4rem">Входящих предложений пока нет</li>';
    return;
  }

  friendRequests.forEach((req, idx) => {
    const li = document.createElement('li');
    li.className = 'friend-item';

    const img = document.createElement('img');
    img.src = getValidAvatar(req.avatar, req.name || req.userId);
    img.alt = req.name;

    const meta = document.createElement('div');
    meta.className = 'friend-meta';

    const nameDiv = document.createElement('div');
    nameDiv.className = 'friend-name';
    nameDiv.textContent = req.name;

    const subDiv = document.createElement('div');
    subDiv.className = 'friend-sub';
    subDiv.textContent = req.userId ? `ID: ${req.userId}` : 'Хочет добавить в друзья';

    meta.appendChild(nameDiv);
    meta.appendChild(subDiv);
    const presenceDiv = document.createElement('div');
    presenceDiv.className = 'friend-presence';
    presenceDiv.dataset.presenceUser = req.supabaseId || '';
    const onlineNow = Boolean(cbPresenceUsers?.[req.supabaseId]);
    presenceDiv.textContent = onlineNow ? '● В сети' : `○ ${cbFormatLastSeen(req.lastSeenAt)}`;
    presenceDiv.classList.add(onlineNow ? 'is-online' : 'is-offline');
    meta.appendChild(presenceDiv);

    const actions = document.createElement('div');
    actions.className = 'friend-actions';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn-primary btn-small';
    okBtn.textContent = 'Принять';
    okBtn.onclick = () => acceptFriendRequest(idx);

    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'btn-secondary btn-small';
    noBtn.textContent = '✕';
    noBtn.onclick = () => declineFriendRequest(idx);

    actions.appendChild(okBtn);
    actions.appendChild(noBtn);

    li.appendChild(img);
    li.appendChild(meta);
    li.appendChild(actions);
    listEl.appendChild(li);
  });
}

function renderFriends() {
  const listEl = document.getElementById('friends-list');
  const countEl = document.getElementById('friends-count');
  if (!listEl || !countEl) return;

  countEl.textContent = friendsList.length;
  listEl.innerHTML = '';

  if (!friendsList.length) {
    listEl.innerHTML = '<li class="friend-sub" style="padding:0.5rem">Список друзей пока пуст.</li>';
    return;
  }

  friendsList.forEach((f, idx) => {
    const li = document.createElement('li');
    li.className = 'friend-item';

    const img = document.createElement('img');
    img.src = getValidAvatar(f.avatar, f.name || f.userId);
    img.alt = f.name;

    const meta = document.createElement('div');
    meta.className = 'friend-meta';

    const nameDiv = document.createElement('div');
    nameDiv.className = 'friend-name';
    nameDiv.textContent = f.name;

    const subDiv = document.createElement('div');
    subDiv.className = 'friend-sub';
    const idPart = f.userId ? `ID: ${f.userId}` : 'Друг';
    const roomPart = f.lastRoom ? ` · Комната: ${f.lastRoom}` : '';
    subDiv.textContent = `${idPart}${roomPart}`;

    meta.appendChild(nameDiv);
    meta.appendChild(subDiv);
    const presenceDiv = document.createElement('div');
    presenceDiv.className = 'friend-presence';
    presenceDiv.dataset.presenceUser = f.supabaseId || '';
    const onlineNow = Boolean(cbPresenceUsers?.[f.supabaseId]);
    presenceDiv.textContent = onlineNow ? '● В сети' : `○ ${cbFormatLastSeen(f.lastSeenAt)}`;
    presenceDiv.classList.add(onlineNow ? 'is-online' : 'is-offline');
    meta.appendChild(presenceDiv);

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
  renderFriendRequests();
  renderFriends();
};

document.getElementById('add-friend-manual-btn').onclick = () => {
  const input = document.getElementById('friend-name-input');
  const val = input.value.trim();
  if (!val) return;
  const inRoomUser = roomState.users.find(u =>
    u.userId === val || u.peerId === val || u.name.toLowerCase() === val.toLowerCase()
  );
  if (inRoomUser) {
    sendFriendRequest(inRoomUser);
  } else if (val.startsWith('u_')) {
    sendFriendRequest({ userId: val, name: val });
  } else {
    sendFriendRequest({ name: val });
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

function updateAvatarPreview() {
  avatarImg.src = getValidAvatar(pendingAvatarDataUrl, avatarSeed);
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
  const finalAvatar = getValidAvatar(pendingAvatarDataUrl, avatarSeed || name);

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
  pendingAvatarDataUrl = getValidAvatar(currentUser.avatar, avatarSeed);
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
  document.getElementById('lobby-avatar').src = getValidAvatar(currentUser.avatar, currentUser.seed || currentUser.name);
  document.getElementById('lobby-username').textContent = currentUser.name;
  document.getElementById('lobby-user-id').textContent = getMyUserId();
  renderFriendRequests();
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
  lastSearchedQuery = '';
  if (typeof cbTrackPresence === 'function') setTimeout(cbTrackPresence, 250);
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

function buildMePayload(myPeerId) {
  return {
    peerId: myPeerId,
    userId: currentUser.id,
    name: currentUser.name,
    avatar: getValidAvatar(currentUser.avatar, currentUser.seed || currentUser.name)
  };
}

function connectGuestToHost(roomId) {
  if (!peer || peer.destroyed || !currentUser) return;
  const hostPeerId = `${PEER_PREFIX}${roomId}`;
  const me = buildMePayload(peer.id);

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
  if (typeof cbTrackPresence === 'function') setTimeout(cbTrackPresence, 250);
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
    const me = buildMePayload(myPeerId);

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
    if (typeof cbTrackPresence === 'function') setTimeout(cbTrackPresence, 500);
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
    conn.on('open', () => {
      if (isHost()) {
        connections.set(conn.peer, conn);
        conn.send({ type: 'state', state: roomState });
      }
    });

    conn.on('data', (msg) => {
      if (!msg || msg.type === 'ping' || msg.type === 'pong') return;
      if (msg.type === 'friend-request') {
        if (isHost() && (msg.toUserId || msg.toPeerId)) {
          const target = roomState.users.find(u =>
            (msg.toUserId && u.userId === msg.toUserId) ||
            (msg.toPeerId && u.peerId === msg.toPeerId)
          );
          if (target && target.peerId === peer.id) {
            handleIncomingFriendRequest(msg);
          } else if (target && target.peerId && target.peerId !== conn.peer) {
            sendDirectPeerMessage(target.peerId, msg);
          }
        } else {
          handleIncomingFriendRequest(msg);
        }
        return;
      }
      if (msg.type === 'friend-accept') {
        if (isHost() && (msg.toUserId || msg.toPeerId)) {
          const target = roomState.users.find(u =>
            (msg.toUserId && u.userId === msg.toUserId) ||
            (msg.toPeerId && u.peerId === msg.toPeerId)
          );
          if (target && target.peerId === peer.id) {
            upsertFriendRecord({ ...msg.from, lastRoom: msg.from.roomId || roomState.id || '' });
          } else if (target && target.peerId && target.peerId !== conn.peer) {
            sendDirectPeerMessage(target.peerId, msg);
          }
        } else {
          upsertFriendRecord({ ...msg.from, lastRoom: msg.from.roomId || roomState.id || '' });
        }
        return;
      }

      if (isHost()) {
        handleMessageAtHost(conn.peer, msg);
      }
    });

    conn.on('close', () => {
      if (!isHost()) return;
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
    avatar: getValidAvatar(currentUser.avatar, currentUser.seed || currentUser.name),
    isHost: Boolean(isHost())
  };
}

function handleMessageAtHost(fromPeerId, msg) {
  if (msg.type === 'join') {
    const cleanUser = {
      ...msg.user,
      avatar: getValidAvatar(msg.user.avatar, msg.user.name || msg.user.userId)
    };
    const idx = roomState.users.findIndex(u => u.peerId === cleanUser.peerId);
    if (idx >= 0) {
      roomState.users[idx] = cleanUser;
    } else {
      roomState.users.push(cleanUser);
      addSystemMessage(`${cleanUser.name} вошёл в комнату`);
    }
    broadcastState();
    updateUI();
  } else if (msg.type === 'chat') {
    const senderObj = {
      ...msg.sender,
      avatar: getValidAvatar(msg.sender?.avatar, msg.sender?.name || msg.sender?.userId),
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
  } else if (msg.type === 'friend-request') {
    if (!msg.toUserId || msg.toUserId === currentUser?.id || msg.toPeerId === peer?.id) {
      handleIncomingFriendRequest(msg);
    }
  } else if (msg.type === 'friend-accept') {
    if (!msg.toUserId || msg.toUserId === currentUser?.id || msg.toPeerId === peer?.id) {
      upsertFriendRecord({ ...msg.from, lastRoom: msg.from.roomId || roomState.id || '' });
    }
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
        ? '🇷🇺 Режим «Для России» включён'
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
  if (!canControlRoom()) return;
  setRuMode(!roomState.ruMode);
};

function updateRuModeUI() {
  const active = Boolean(roomState.ruMode);
  ruToggleBtn.classList.toggle('active', active);
  ruToggleBtn.setAttribute('aria-pressed', String(active));
  ruToggleBtn.textContent = active ? 'Вкл' : 'Выкл';
  ruToggleBtn.disabled = !canControlRoom();

  googleHint.textContent = active
    ? '🇷🇺 Режим для России включён — поиск видео и быстрый запуск в браузере'
    : 'Введи запрос для поиска видео или вставь ссылку — откроется в браузере со звуком';
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

  browserControls.style.display = canControlRoom() ? 'flex' : 'none';

  const framingNow = Boolean(roomState.videoFocus) && !roomState.cropApplied;
  if (canControlRoom() || framingNow) {
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
    avatar: getValidAvatar(currentUser?.avatar, currentUser?.seed || currentUser?.name)
  }];

  usersToRender.forEach(u => {
    const li = document.createElement('li');
    li.className = 'user-item';

    const isUserHost = u.peerId === roomState.hostPeerId;
    const isUserCtrl = u.peerId === roomState.controllerPeerId;
    const isSelf = (peer && u.peerId === peer.id) || (currentUser && u.userId === currentUser.id);

    const img = document.createElement('img');
    img.src = getValidAvatar(u.avatar, u.name || u.userId);

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
      const isPending = !alreadyFriend && hasOutgoingRequest(u);
      friendBtn.className = `friend-add-btn ${alreadyFriend ? 'added' : (isPending ? 'pending' : '')}`;
      friendBtn.textContent = alreadyFriend ? '✓ Друг' : (isPending ? '⏳ Заявка' : '+ В друзья');
      friendBtn.disabled = alreadyFriend || isPending;
      friendBtn.onclick = () => sendFriendRequest(u);
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

// --- 3. ПОИСК YOUTUBE + НАДЁЖНЫЙ ЗАПУСК В БРАУЗЕРЕ ---
const iframe = document.getElementById('virtual-browser-frame');
const googleLauncher = document.getElementById('google-launcher');
const topInput = document.getElementById('neko-url-input');
const googleQueryInput = document.getElementById('google-query-input');
const ytSearchStatusEl = document.getElementById('yt-search-status');
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

function extractYouTubeId(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  const directIdMatch = trimmed.match(/^[a-zA-Z0-9_-]{11}$/);
  if (directIdMatch) return directIdMatch[0];

  try {
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(normalized);
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.replace(/^\/+/, '').split('/')[0];
      return id ? id.slice(0, 11) : null;
    }
    if (u.hostname.includes('youtube.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v').slice(0, 11);
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex(p => p === 'shorts' || p === 'embed' || p === 'live' || p === 'v');
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1].slice(0, 11);
    }
  } catch (_) {}
  return null;
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

function syncUrlToRoom(url, label = '') {
  if (!url || !canControlRoom()) return false;
  sendNavigation({
    mode: 'search',
    query: roomState.query || label || '',
    browserUrl: url,
    videoFocus: false,
    cropApplied: false
  });
  return true;
}

function createVideoCard({ url, title, channel, durationSec, thumb, isDirectVideo = false }) {
  const card = document.createElement('div');
  card.className = 'yt-video-card';

  if (thumb) {
    const img = document.createElement('img');
    img.className = 'yt-video-thumb';
    img.src = thumb;
    img.alt = title || 'Видео';
    img.loading = 'lazy';
    card.appendChild(img);
  }

  const info = document.createElement('div');
  info.className = 'yt-video-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'yt-video-title';
  titleEl.textContent = title || 'Видео';

  const dur = formatDuration(durationSec);
  const metaParts = [channel, dur, isDirectVideo ? 'Прямой запуск видео' : ''].filter(Boolean);
  const metaEl = document.createElement('div');
  metaEl.className = 'yt-video-meta';
  metaEl.textContent = metaParts.join(' • ') || 'YouTube';

  const actions = document.createElement('div');
  actions.className = 'yt-video-actions';

  const openLink = document.createElement('a');
  openLink.className = 'btn-primary btn-small';
  openLink.href = url;
  openLink.target = '_blank';
  openLink.rel = 'noopener noreferrer';
  openLink.style.textDecoration = 'none';
  openLink.style.display = 'inline-flex';
  openLink.style.alignItems = 'center';
  openLink.textContent = '▶ Запустить в браузере';
  openLink.addEventListener('click', () => {
    syncUrlToRoom(url, title);
  });

  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'btn-secondary btn-small';
  syncBtn.textContent = 'Кинуть в комнату';
  syncBtn.onclick = () => {
    if (!canControlRoom()) {
      return alert('Синхронизировать ссылку может участник с пультом или Главный (👑).');
    }
    syncUrlToRoom(url, title);
    if (ytSearchStatusEl) {
      ytSearchStatusEl.textContent = 'Ссылка отправлена участникам комнаты';
    }
  };

  actions.append(openLink, syncBtn);
  info.append(titleEl, metaEl, actions);
  card.appendChild(info);
  return card;
}

async function renderSearchHub(query) {
  const q = (query || '').trim();
  searchResultsEl.innerHTML = '';

  if (!q) {
    lastSearchedQuery = '';
    if (ytSearchStatusEl) ytSearchStatusEl.textContent = '';
    return;
  }

  const ytId = extractYouTubeId(q);
  if (ytId) {
    const watchUrl = `https://www.youtube.com/watch?v=${ytId}`;
    lastSearchedQuery = q;
    if (ytSearchStatusEl) {
      ytSearchStatusEl.textContent = 'Видео готово к запуску в браузере со звуком';
    }
    searchResultsEl.appendChild(createVideoCard({
      url: watchUrl,
      title: `Видео YouTube (${ytId})`,
      channel: 'YouTube',
      durationSec: 0,
      thumb: `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
      isDirectVideo: true
    }));
    return;
  }

  if (isDirectUrl(q)) {
    const fullUrl = toFullUrl(q);
    lastSearchedQuery = q;
    if (ytSearchStatusEl) {
      ytSearchStatusEl.textContent = 'Ссылка готова к открытию в браузере';
    }
    searchResultsEl.appendChild(createVideoCard({
      url: fullUrl,
      title: 'Открыть ссылку в браузере',
      channel: 'Внешний сайт',
      durationSec: 0,
      thumb: ''
    }));
    return;
  }

  if (q === lastSearchedQuery && searchResultsEl.children.length) return;
  lastSearchedQuery = q;

  if (ytSearchStatusEl) ytSearchStatusEl.textContent = `Ищу «${q}»...`;

  for (const base of PIPED_INSTANCES) {
    try {
      const res = await fetch(
        `${base}/search?q=${encodeURIComponent(q)}&filter=videos`,
        { signal: AbortSignal.timeout(3500) }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const items = Array.isArray(data.items)
        ? data.items
            .filter(x => x.type === 'stream' || (x.url && x.url.includes('/watch?v=')))
            .slice(0, 8)
        : [];

      if (!items.length) continue;

      if (ytSearchStatusEl) {
        ytSearchStatusEl.textContent = `Найдено роликов: ${items.length}`;
      }

      const frag = document.createDocumentFragment();
      for (const v of items) {
        const id = (v.url || '').split('/watch?v=')[1]?.split('&')[0];
        if (!id) continue;
        frag.appendChild(createVideoCard({
          url: `https://www.youtube.com/watch?v=${id}`,
          title: v.title || 'Без названия',
          channel: v.uploaderName || 'YouTube',
          durationSec: v.duration || 0,
          thumb: v.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          isDirectVideo: true
        }));
      }
      if (frag.children.length) {
        searchResultsEl.replaceChildren(frag);
        return;
      }
    } catch (_) {}
  }

  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const res = await fetch(
        `${base}/api/v1/search?q=${encodeURIComponent(q)}&type=video`,
        { signal: AbortSignal.timeout(3500) }
      );
      if (!res.ok) continue;
      const list = await res.json();
      const videos = Array.isArray(list) ? list.filter(v => v.videoId).slice(0, 8) : [];
      if (!videos.length) continue;

      if (ytSearchStatusEl) {
        ytSearchStatusEl.textContent = `Найдено роликов: ${videos.length}`;
      }

      const frag = document.createDocumentFragment();
      for (const v of videos) {
        frag.appendChild(createVideoCard({
          url: `https://www.youtube.com/watch?v=${v.videoId}`,
          title: v.title || 'Без названия',
          channel: v.author || 'YouTube',
          durationSec: v.lengthSeconds || 0,
          thumb: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          isDirectVideo: true
        }));
      }
      searchResultsEl.replaceChildren(frag);
      return;
    } catch (_) {}
  }

  const ytSearchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  if (ytSearchStatusEl) {
    ytSearchStatusEl.textContent = 'Список API недоступен — открой выдачу на YouTube в браузере';
  }
  searchResultsEl.appendChild(createVideoCard({
    url: ytSearchUrl,
    title: `Поиск «${q}» на YouTube`,
    channel: 'YouTube',
    durationSec: 0,
    thumb: ''
  }));
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

    const activeQuery = roomState.query || '';
    if (activeQuery && activeQuery !== lastSearchedQuery) {
      if (document.activeElement !== googleQueryInput) googleQueryInput.value = activeQuery;
      if (document.activeElement !== topInput) topInput.value = activeQuery;
      renderSearchHub(activeQuery);
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

function handleSearchOrOpen(rawValue, openDirectIfUrl = false) {
  const val = (rawValue || '').trim();
  if (!val) {
    lastSearchedQuery = '';
    sendNavigation({ mode: 'search', query: '', browserUrl: '', videoFocus: false, cropApplied: false });
    searchResultsEl.innerHTML = '';
    if (ytSearchStatusEl) ytSearchStatusEl.textContent = '';
    return;
  }

  const ytId = extractYouTubeId(val);
  if (ytId) {
    const watchUrl = `https://www.youtube.com/watch?v=${ytId}`;
    lastSearchedQuery = '';
    sendNavigation({ mode: 'search', query: watchUrl, browserUrl: watchUrl, videoFocus: false, cropApplied: false });
    renderSearchHub(watchUrl);
    if (openDirectIfUrl) {
      window.open(watchUrl, '_blank', 'noopener,noreferrer');
    }
    return;
  }

  if (isDirectUrl(val)) {
    const url = toFullUrl(val);
    lastSearchedQuery = '';
    sendNavigation({ mode: 'search', query: url, browserUrl: url, videoFocus: false, cropApplied: false });
    renderSearchHub(url);
    if (openDirectIfUrl) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    return;
  }

  lastSearchedQuery = '';
  sendNavigation({ mode: 'search', query: val, browserUrl: '', videoFocus: false, cropApplied: false });
  renderSearchHub(val);
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
  handleSearchOrOpen(googleQueryInput.value, false);
};

googleQueryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleSearchOrOpen(googleQueryInput.value, false);
  }
});

document.getElementById('external-open-btn').onclick = () => {
  const q = (topInput.value || googleQueryInput.value || roomState.browserUrl || roomState.query || '').trim();
  const ytId = extractYouTubeId(q);
  const target = ytId
    ? `https://www.youtube.com/watch?v=${ytId}`
    : (isDirectUrl(q)
        ? toFullUrl(q)
        : (q ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` : 'https://www.youtube.com'));
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
    ? { name: sender, avatar: currentUser?.avatar, isHost: Boolean(isHost()) }
    : sender;

  const img = document.createElement('img');
  img.className = 'msg-avatar';
  img.src = getValidAvatar(senderObj.avatar, senderObj.name || senderObj.userId);
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
  currentUser.avatar = getValidAvatar(currentUser.avatar, currentUser.seed || currentUser.name);
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


// ================= SUPABASE: ДРУЗЬЯ И ЛИЧНЫЕ СООБЩЕНИЯ =================
const COBROWSER_SUPABASE_URL = 'https://dtrihjdxpwpahhpozxlo.supabase.co';
const COBROWSER_SUPABASE_KEY = 'sb_publishable_Nc3Ce_vjJnB03BOMGQIydQ_8oJwRmtw';
let cbSupabase = null;
let cbAuthUser = null;
let cbProfile = null;
let cbSelectedFriend = null;
let cbRealtime = [];

function cbNotice(message) { alert(message); }
function cbPublicId() {
  if (!currentUser.id || !String(currentUser.id).startsWith('u_')) {
    currentUser.id = 'u_' + Math.random().toString(36).slice(2, 10);
  }
  return currentUser.id;
}
async function cbInit() {
  try {
    if (!window.supabase?.createClient) throw new Error('Не загрузилась библиотека Supabase.');
    cbSupabase = window.supabase.createClient(COBROWSER_SUPABASE_URL, COBROWSER_SUPABASE_KEY);
    let { data: sessionData, error } = await cbSupabase.auth.getSession();
    if (error) throw error;
    if (!sessionData.session) {
      const signed = await cbSupabase.auth.signInAnonymously();
      if (signed.error) throw signed.error;
      sessionData = { session: signed.data.session };
    }
    cbAuthUser = sessionData.session.user;
    if (currentUser?.name) await cbEnsureProfile();
    cbStartLastSeenHeartbeat();
    await cbLoadSocial();
    cbSubscribeSocial();
    cbStartPresence();
    cbSetSocialStatus('Подключено к синхронизации');
  } catch (e) {
    console.error('CoBrowser Supabase:', e);
    cbSetSocialStatus('Ошибка подключения: ' + (e.message || e));
  }
}
function cbSetSocialStatus(message) {
  const el = document.getElementById('social-status');
  if (el) el.textContent = message;
}
async function cbEnsureProfile() {
  if (!cbSupabase || !cbAuthUser || !currentUser?.name) return;
  const public_id = cbPublicId();
  const profile = {
    id: cbAuthUser.id, public_id,
    name: currentUser.name,
    avatar: getValidAvatar(currentUser.avatar, currentUser.seed || currentUser.name)
  };
  const { data, error } = await cbSupabase.from('profiles')
    .upsert(profile, { onConflict: 'id' }).select().single();
  if (error) throw error;
  cbProfile = data;
  currentUser.supabaseId = cbAuthUser.id;
  localStorage.setItem('cobrowser_user', JSON.stringify(currentUser));
  if (cbPresenceChannel) await cbTrackPresence();
  const idEl = document.getElementById('lobby-user-id');
  if (idEl) idEl.textContent = public_id;
}
async function cbLoadSocial() {
  if (!cbSupabase || !cbAuthUser) return;
  const uid = cbAuthUser.id;
  const [incoming, outgoing, links] = await Promise.all([
    cbSupabase.from('friend_requests').select('id,sender_id,receiver_id,status,created_at').eq('receiver_id', uid).eq('status','pending'),
    cbSupabase.from('friend_requests').select('id,sender_id,receiver_id,status,created_at').eq('sender_id', uid).eq('status','pending'),
    cbSupabase.from('friendships').select('user_a,user_b').or(`user_a.eq.${uid},user_b.eq.${uid}`)
  ]);
  for (const r of [incoming,outgoing,links]) if (r.error) throw r.error;
  const ids = [...new Set([
    ...incoming.data.map(x=>x.sender_id), ...outgoing.data.map(x=>x.receiver_id),
    ...links.data.map(x=>x.user_a===uid?x.user_b:x.user_a)
  ])];
  let profiles = [];
  if (ids.length) {
    const p = await cbSupabase.from('profiles').select('id,public_id,name,avatar,last_seen_at').in('id', ids);
    if (p.error) throw p.error;
    profiles = p.data;
  }
  const byId = new Map(profiles.map(p=>[p.id,p]));
  friendRequests = incoming.data.map(r=>({...byId.get(r.sender_id), requestId:r.id, userId:byId.get(r.sender_id)?.public_id}));
  outgoingRequests = outgoing.data.map(r=>({...byId.get(r.receiver_id), requestId:r.id}));
  friendsList = links.data.map(r=>byId.get(r.user_a===uid?r.user_b:r.user_a)).filter(Boolean)
    .map(p=>({userId:p.public_id,name:p.name,avatar:p.avatar,supabaseId:p.id,lastSeenAt:p.last_seen_at}));
  renderFriendRequests(); renderFriends();
  const count = document.getElementById('friends-count');
  if (count) count.textContent = friendsList.length;
  cbRenderDmFriends();
}
async function cbSubscribeSocial() {
  if (!cbSupabase || !cbAuthUser) return;
  cbRealtime.forEach(ch=>cbSupabase.removeChannel(ch));
  const uid = cbAuthUser.id;
  const channel = cbSupabase.channel('cobrowser-social-'+uid)
    .on('postgres_changes',{event:'*',schema:'public',table:'friend_requests',filter:`receiver_id=eq.${uid}`}, async()=>{await cbLoadSocial();})
    .on('postgres_changes',{event:'*',schema:'public',table:'friendships'}, async()=>{await cbLoadSocial();})
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'direct_messages',filter:`receiver_id=eq.${uid}`}, payload=>{
      if (cbSelectedFriend && payload.new.sender_id===cbSelectedFriend.supabaseId) cbLoadDirectMessages();
      cbSetSocialStatus('Новое личное сообщение');
    }).subscribe();
  cbRealtime=[channel];
}
async function cbSendFriendRequest(value) {
  if (!cbSupabase || !cbAuthUser) return cbNotice('Подключение к базе ещё не готово. Обнови страницу.');
  await cbEnsureProfile();
  const term=value.trim();
  if (!term) return;
  const {data:target,error}=await cbSupabase.from('profiles').select('id,public_id,name,avatar')
    .or(`public_id.eq.${term.replace(/[(),]/g,'')},name.ilike.${term.replace(/[%,]/g,'')}`).limit(2);
  if(error) return cbNotice('Не удалось найти пользователя: '+error.message);
  if(!target?.length) return cbNotice('Пользователь не найден. Попроси его прислать свой ID из профиля.');
  if(target.length>1) return cbNotice('Нашлось несколько пользователей с таким ником. Введи точный ID.');
  const p=target[0];
  if(p.id===cbAuthUser.id) return cbNotice('Нельзя добавить самого себя.');
  const {data:existing}=await cbSupabase.from('friendships').select('user_a').or(`and(user_a.eq.${cbAuthUser.id},user_b.eq.${p.id}),and(user_a.eq.${p.id},user_b.eq.${cbAuthUser.id})`).maybeSingle();
  if(existing) return cbNotice('Вы уже друзья.');
  const {error:insertError}=await cbSupabase.from('friend_requests').insert({sender_id:cbAuthUser.id,receiver_id:p.id});
  if(insertError) {
    if(insertError.code==='23505') return cbNotice('Заявка этому пользователю уже отправлена.');
    return cbNotice('Не удалось отправить заявку: '+insertError.message);
  }
  await cbLoadSocial();
  cbNotice('Заявка отправлена пользователю '+p.name+'.');
}
async function cbAcceptRequest(requestId) {
  const {error}=await cbSupabase.from('friend_requests').update({status:'accepted'}).eq('id',requestId).eq('receiver_id',cbAuthUser.id);
  if(error) return cbNotice('Ошибка принятия заявки: '+error.message);
  await cbLoadSocial();
}
async function cbDeclineRequest(requestId) {
  const {error}=await cbSupabase.from('friend_requests').update({status:'declined'}).eq('id',requestId).eq('receiver_id',cbAuthUser.id);
  if(error) return cbNotice('Ошибка: '+error.message);
  await cbLoadSocial();
}
function cbInstallDmUI() {
  const tabBar = document.querySelector('.lobby-tabs');
  const chatTab = document.createElement('button');
  chatTab.type = 'button'; chatTab.id = 'tab-chat-btn'; chatTab.className = 'tab-btn';
  chatTab.textContent = 'Сообщения';
  tabBar.appendChild(chatTab);

  const panel = document.createElement('div');
  panel.id = 'lobby-tab-chat'; panel.className = 'tab-panel';
  panel.innerHTML = `<section class="personal-chat-panel">
    <div class="dm-heading"><div><h2>Личные сообщения</h2><p>Переписка один на один с друзьями</p></div></div>
    <div class="dm-layout">
      <aside class="dm-sidebar"><div class="dm-sidebar-title">Друзья</div><div id="dm-friends" class="dm-friends"><p class="friend-sub">Добавь друга, чтобы начать переписку</p></div></aside>
      <section class="dm-conversation">
        <div class="dm-title" id="dm-title"><span class="dm-empty-avatar">✉</span><span>Выбери друга</span></div>
        <div id="dm-messages" class="dm-messages"><div class="dm-empty">Выбери друга слева, чтобы открыть переписку</div></div>
        <form id="dm-form" class="dm-form"><input id="dm-input" maxlength="2000" placeholder="Написать сообщение..." autocomplete="off"><button type="submit" aria-label="Отправить">➤</button></form>
      </section>
    </div>
  </section>`;
  document.getElementById('lobby-tab-friends').after(panel);

  const style = document.createElement('style');
  style.textContent = `
  #social-status{font-size:.78rem;color:var(--muted);margin-top:.5rem}
  .lobby-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));}
  .lobby-tabs .tab-btn{min-width:0;padding:.75rem .35rem;font-size:.9rem}
  .personal-chat-panel{margin:0;padding:.2rem 0 .5rem}
  .dm-heading h2{margin:0 0 .25rem;font-size:1.25rem}.dm-heading p{margin:0 0 1rem;color:var(--muted);font-size:.85rem}
  .dm-layout{display:grid;grid-template-columns:minmax(130px,.72fr) minmax(0,1.6fr);gap:.75rem;min-height:390px}
  .dm-sidebar,.dm-conversation{min-width:0;border:1px solid var(--border,#343943);border-radius:15px;background:rgba(10,12,18,.35);overflow:hidden}
  .dm-sidebar-title{padding:.85rem .9rem;font-weight:700;border-bottom:1px solid var(--border,#343943)}
  .dm-friends{padding:.45rem;max-height:450px;overflow:auto}
  .dm-friend{display:flex;align-items:center;gap:.6rem;width:100%;text-align:left;margin:.25rem 0;padding:.65rem .55rem;border:1px solid transparent;border-radius:11px;background:transparent;color:inherit;cursor:pointer}
  .dm-friend:hover,.dm-friend.active{background:rgba(105,99,255,.15);border-color:var(--accent,#7770ff)}
  .dm-friend img{width:38px;height:38px;flex:0 0 38px;object-fit:cover;border-radius:50%}
  .dm-friend-name{font-weight:650;overflow:hidden;text-overflow:ellipsis}
  .dm-conversation{display:flex;flex-direction:column;min-height:390px}
  .dm-title{display:flex;align-items:center;gap:.7rem;padding:.75rem .9rem;font-weight:700;border-bottom:1px solid var(--border,#343943);min-height:62px}
  .dm-title img{width:38px;height:38px;border-radius:50%;object-fit:cover}
  .dm-messages{flex:1;min-height:240px;max-height:440px;overflow:auto;padding:1rem;display:flex;flex-direction:column;gap:.8rem}
  .dm-empty{margin:auto;text-align:center;color:var(--muted);font-size:.9rem;padding:1rem}
  .dm-message-row{display:flex;align-items:flex-end;gap:.5rem;max-width:92%}
  .dm-message-row.mine{align-self:flex-end;flex-direction:row-reverse}
  .dm-message-row img{width:30px;height:30px;border-radius:50%;object-fit:cover;flex:0 0 30px}
  .dm-bubble-wrap{min-width:0}.dm-author{font-size:.72rem;color:var(--muted);margin:0 0 .2rem .2rem}
  .dm-message{padding:.65rem .85rem;border-radius:14px 14px 14px 4px;background:#292e3b;color:#f4f5fa;overflow-wrap:anywhere;white-space:pre-wrap;line-height:1.4}
  .dm-message-row.mine .dm-message{background:#5551c9;border-radius:14px 14px 4px 14px}
  .dm-time{font-size:.65rem;color:var(--muted);margin:.2rem .25rem 0}
  .dm-form{display:flex;gap:.55rem;padding:.75rem;border-top:1px solid var(--border,#343943)}
  .dm-form input{flex:1;min-width:0;border-radius:12px;padding:.8rem .9rem}
  .dm-form button{width:46px;flex:0 0 46px;border:0;border-radius:12px;background:var(--accent,#6862ed);color:white;font-size:1.2rem}

  .friend-presence{font-size:.76rem;margin-top:.25rem}
  .friend-presence.is-online{color:#55d99a}
  .friend-presence.is-offline{color:#9298a5}
  #friends-list .friend-item{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap}
  #friends-list .friend-meta{flex:1;min-width:110px}
  #friends-list .friend-actions{display:flex;gap:.35rem;flex-wrap:wrap}

  @media(max-width:600px){.dm-layout{grid-template-columns:1fr;min-height:0}.dm-sidebar{max-height:150px}.dm-friends{display:flex;gap:.3rem;max-height:100px;overflow-x:auto}.dm-friend{width:auto;min-width:100px;flex-direction:column;gap:.25rem;text-align:center}.dm-conversation{min-height:420px}.dm-messages{min-height:270px;max-height:360px}.lobby-tabs .tab-btn{font-size:.78rem}}
  `;
  document.head.appendChild(style);

  function showTab(which) {
    ['room','friends','chat'].forEach(name=>{
      document.getElementById('lobby-tab-'+name)?.classList.toggle('active',name===which);
      document.getElementById('tab-'+name+'-btn')?.classList.toggle('active',name===which);
    });
    if(which==='chat') cbRenderDmFriends();
  }
  document.getElementById('tab-room-btn').onclick=()=>showTab('room');
  document.getElementById('tab-friends-btn').onclick=()=>{showTab('friends');renderFriendRequests();renderFriends();};
  chatTab.onclick=()=>showTab('chat');

  document.getElementById('dm-form').onsubmit=async e=>{
    e.preventDefault();
    const input=document.getElementById('dm-input'), body=input.value.trim();
    if(!body||!cbSelectedFriend)return;
    const {error}=await cbSupabase.from('direct_messages').insert({sender_id:cbAuthUser.id,receiver_id:cbSelectedFriend.supabaseId,body});
    if(error)return cbNotice('Не удалось отправить сообщение: '+error.message);
    input.value=''; await cbLoadDirectMessages();
  };
}
function cbRenderDmFriends() {
  const el=document.getElementById('dm-friends'); if(!el)return;
  el.innerHTML='';
  if(!friendsList.length){el.innerHTML='<p class="friend-sub">Пока нет друзей</p>';return;}
  friendsList.forEach(f=>{
    const b=document.createElement('button'); b.type='button'; b.className='dm-friend'+(cbSelectedFriend?.supabaseId===f.supabaseId?' active':'');
    const img=document.createElement('img'); img.src=getValidAvatar(f.avatar,f.name||f.userId); img.alt='';
    const info=document.createElement('span'); info.className='dm-friend-info';
    const name=document.createElement('span'); name.className='dm-friend-name'; name.textContent=f.name;
    const status=document.createElement('small'); status.className='friend-presence'; status.dataset.presenceUser=f.supabaseId || '';
    const online=Boolean(cbPresenceUsers[f.supabaseId]);
    status.textContent=online?'● В сети':`○ ${cbFormatLastSeen(f.lastSeenAt)}`;
    status.classList.add(online?'is-online':'is-offline');
    info.append(name,status);
    b.append(img,info); b.onclick=()=>{cbSelectedFriend=f;cbRenderDmFriends();cbLoadDirectMessages();};
    el.appendChild(b);
  });
}
async function cbLoadDirectMessages() {
  if(!cbSelectedFriend||!cbSupabase)return;
  const title=document.getElementById('dm-title'); title.innerHTML='';
  const titleImg=document.createElement('img'); titleImg.src=getValidAvatar(cbSelectedFriend.avatar,cbSelectedFriend.name); titleImg.alt='';
  const titleInfo=document.createElement('span');
  const titleName=document.createElement('strong'); titleName.textContent=cbSelectedFriend.name;
  const titleStatus=document.createElement('small'); titleStatus.className='friend-presence'; titleStatus.dataset.presenceUser=cbSelectedFriend.supabaseId || '';
  const selectedOnline=Boolean(cbPresenceUsers[cbSelectedFriend.supabaseId]);
  titleStatus.textContent=selectedOnline?'● В сети':`○ ${cbFormatLastSeen(cbSelectedFriend.lastSeenAt)}`;
  titleStatus.classList.add(selectedOnline?'is-online':'is-offline');
  titleInfo.append(titleName,titleStatus);
  title.append(titleImg,titleInfo);
  const uid=cbAuthUser.id, other=cbSelectedFriend.supabaseId;
  const {data,error}=await cbSupabase.from('direct_messages').select('id,sender_id,receiver_id,body,created_at')
    .or(`and(sender_id.eq.${uid},receiver_id.eq.${other}),and(sender_id.eq.${other},receiver_id.eq.${uid})`)
    .order('created_at',{ascending:true}).limit(300);
  if(error){cbSetSocialStatus('Ошибка загрузки переписки: '+error.message);return;}
  const el=document.getElementById('dm-messages');el.innerHTML='';
  if(!(data||[]).length){el.innerHTML='<div class="dm-empty">Пока нет сообщений. Напиши первым!</div>';return;}
  (data||[]).forEach(m=>{
    const mine=m.sender_id===uid, row=document.createElement('div'); row.className='dm-message-row'+(mine?' mine':'');
    const avatar=document.createElement('img'); avatar.src=mine?getValidAvatar(currentUser?.avatar,currentUser?.name):getValidAvatar(cbSelectedFriend.avatar,cbSelectedFriend.name); avatar.alt='';
    const wrap=document.createElement('div'); wrap.className='dm-bubble-wrap';
    const author=document.createElement('div'); author.className='dm-author'; author.textContent=mine?'Вы':cbSelectedFriend.name;
    const bubble=document.createElement('div'); bubble.className='dm-message'; bubble.textContent=m.body;
    const time=document.createElement('div'); time.className='dm-time'; time.textContent=new Date(m.created_at).toLocaleString('ru-RU',{hour:'2-digit',minute:'2-digit'});
    wrap.append(author,bubble,time); row.append(avatar,wrap); el.appendChild(row);
  });
  el.scrollTop=el.scrollHeight;
}
function cbOverrideFriendUI() {
  const add=document.getElementById('add-friend-manual-btn');
  if(add)add.onclick=async()=>{const input=document.getElementById('friend-name-input');await cbSendFriendRequest(input.value);input.value='';};
  window.acceptFriendRequest=cbAcceptRequest;
  window.renderFriendRequests=function(){
    const list=document.getElementById('friend-requests-list'), count=document.getElementById('requests-count'), badge=document.getElementById('friend-req-badge');
    if(!list)return;count.textContent=friendRequests.length;badge.textContent=friendRequests.length;badge.classList.toggle('hidden',!friendRequests.length);list.innerHTML='';
    if(!friendRequests.length){list.innerHTML='<li class="friend-sub">Входящих предложений пока нет</li>';return;}
    friendRequests.forEach(r=>{const li=document.createElement('li');li.className='friend-item';const meta=document.createElement('div');meta.className='friend-meta';const n=document.createElement('div');n.className='friend-name';n.textContent=r.name;const sub=document.createElement('div');sub.className='friend-sub';sub.textContent='ID: '+r.public_id;meta.append(n,sub);const actions=document.createElement('div');actions.className='friend-actions';const ok=document.createElement('button');ok.className='btn-primary btn-small';ok.textContent='Принять';ok.onclick=()=>cbAcceptRequest(r.requestId);const no=document.createElement('button');no.className='btn-secondary btn-small';no.textContent='✕';no.onclick=()=>cbDeclineRequest(r.requestId);actions.append(ok,no);li.append(meta,actions);list.append(li);});
  };
  window.renderFriends=function(){
    const list=document.getElementById('friends-list'),count=document.getElementById('friends-count');if(!list)return;count.textContent=friendsList.length;list.innerHTML='';
    if(!friendsList.length){list.innerHTML='<li class="friend-sub">Пока нет друзей</li>';return;}
    friendsList.forEach(f=>{const li=document.createElement('li');li.className='friend-item';const avatar=document.createElement('img');avatar.src=getValidAvatar(f.avatar,f.name||f.userId);avatar.alt='';const meta=document.createElement('div');meta.className='friend-meta';const n=document.createElement('div');n.className='friend-name';n.textContent=f.name;const sub=document.createElement('div');sub.className='friend-sub';sub.textContent='ID: '+f.userId;meta.append(n,sub);
      const presence=document.createElement('div');presence.className='friend-presence';presence.dataset.presenceUser=f.supabaseId;
      const online=Boolean(cbPresenceUsers[f.supabaseId]);presence.textContent=online?'● В сети':'○ Не в сети';presence.classList.add(online?'is-online':'is-offline');meta.append(presence);
      const actions=document.createElement('div');actions.className='friend-actions';
      const roomBtn=document.createElement('button');roomBtn.type='button';roomBtn.className='btn-secondary btn-small';roomBtn.textContent=(activeRoomId&&isHost())?'Пригласить':'Попроситься в комнату';
      roomBtn.onclick=()=>{if(activeRoomId&&isHost())cbInviteFriendToRoom(f);else cbAskToJoinRoom(f);};
      actions.append(roomBtn);li.append(avatar,meta,actions);list.append(li);});
  };
}
async function cbRefreshProfile() {
  if(!cbSupabase||!cbAuthUser)return;
  try { await cbEnsureProfile(); await cbLoadSocial(); } catch(e){console.error(e);cbSetSocialStatus('Ошибка профиля: '+e.message);}
}
cbInstallDmUI();
cbOverrideFriendUI();
const socialStatus=document.createElement('div');socialStatus.id='social-status';socialStatus.textContent='Подключение...';
document.querySelector('.user-badge')?.after(socialStatus);
const originalSaveProfile=document.getElementById('save-profile-btn').onclick;
document.getElementById('save-profile-btn').onclick=async function(){
  if(originalSaveProfile) originalSaveProfile();
  for(let i=0;i<30&&!cbAuthUser;i++) await new Promise(r=>setTimeout(r,200));
  if(cbAuthUser) await cbRefreshProfile();
};
cbInit();


// ================= ONLINE / ROOM INVITES =================
let cbPresenceChannel = null;
let cbPresenceUsers = {};
let cbPresenceReady = false;

let cbLastSeenTimer = null;
async function cbSaveLastSeen() {
  if (!cbSupabase || !cbAuthUser) return;
  const stamp = new Date().toISOString();
  const { error } = await cbSupabase.from('profiles')
    .update({ last_seen_at: stamp }).eq('id', cbAuthUser.id);
  if (error) console.warn('Не удалось сохранить время последнего посещения:', error);
  if (cbProfile) cbProfile.last_seen_at = stamp;
  friendsList.forEach(f => { if (f.supabaseId === cbAuthUser.id) f.lastSeenAt = stamp; });
}
function cbFormatLastSeen(value) {
  if (!value) return 'Был(а) в сети: неизвестно';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Был(а) в сети: неизвестно';
  const diff = Math.max(0, Date.now() - date.getTime());
  if (diff < 60_000) return 'Был(а) в сети: меньше минуты назад';
  if (diff < 3_600_000) return `Был(а) в сети: ${Math.floor(diff/60_000)} мин. назад`;
  if (diff < 86_400_000) return `Был(а) в сети: ${Math.floor(diff/3_600_000)} ч. назад`;
  return 'Был(а) в сети: ' + date.toLocaleString([], {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
}
function cbStartLastSeenHeartbeat() {
  if (cbLastSeenTimer) clearInterval(cbLastSeenTimer);
  cbSaveLastSeen();
  cbLastSeenTimer = setInterval(cbSaveLastSeen, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') cbSaveLastSeen();
  });
  window.addEventListener('pagehide', () => {
    cbSaveLastSeen();
  });
}
function cbPresenceSnapshot() {
  const state = cbPresenceChannel?.presenceState?.() || {};
  const found = {};
  Object.values(state).flat().forEach(meta => {
    if (meta?.user_id) found[meta.user_id] = meta;
  });
  cbPresenceUsers = found;
  cbUpdatePresenceLabels();
}
async function cbTrackPresence() {
  if (!cbPresenceChannel || !cbAuthUser || !cbProfile) return;
  const roomCode = (activeRoomId || '').toString();
  const meta = {
    user_id: cbAuthUser.id,
    public_id: cbProfile.public_id,
    name: currentUser?.name || cbProfile.name,
    avatar: getValidAvatar(currentUser?.avatar, currentUser?.name),
    room_code: roomCode,
    in_room: Boolean(roomCode),
    is_host: Boolean(roomCode && isHost()),
    updated_at: new Date().toISOString()
  };
  const { error } = await cbPresenceChannel.track(meta);
  if (error) console.warn('Presence track:', error);
  cbPresenceSnapshot();
}
function cbUpdatePresenceLabels() {
  document.querySelectorAll('[data-presence-user]').forEach(el => {
    const id = el.dataset.presenceUser;
    const online = Boolean(cbPresenceUsers[id]);
    const friend = friendsList.find(f => f.supabaseId === id);
    el.textContent = online ? '● В сети' : `○ ${cbFormatLastSeen(friend?.lastSeenAt)}`;
    el.classList.toggle('is-online', online);
    el.classList.toggle('is-offline', !online);
  });
  document.querySelectorAll('[data-room-user]').forEach(el => {
    const meta = cbPresenceUsers[el.dataset.roomUser];
    el.textContent = meta?.in_room ? `В комнате ${meta.room_code}` : (meta ? 'В сети' : 'Не в сети');
  });
}

function cbShowRoomDialog({title, message, name, avatar, roomCode, acceptText='Войти', cancelText='Отмена'}) {
  return new Promise(resolve => {
    const old = document.querySelector('.cb-dialog-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.className = 'cb-dialog-overlay';
    const card = document.createElement('div');
    card.className = 'cb-dialog-card';
    const avatarEl = document.createElement('div');
    avatarEl.className = 'cb-dialog-avatar';
    if (avatar) {
      const img = document.createElement('img');
      img.src = avatar;
      img.alt = '';
      avatarEl.appendChild(img);
    } else {
      avatarEl.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
    }
    const heading = document.createElement('h3');
    heading.textContent = title;
    const who = document.createElement('div');
    who.className = 'cb-dialog-name';
    who.textContent = name || 'Друг';
    const body = document.createElement('p');
    body.className = 'cb-dialog-message';
    body.textContent = message;
    card.append(avatarEl, heading, who, body);
    if (roomCode) {
      const room = document.createElement('div');
      room.className = 'cb-dialog-room';
      room.textContent = 'Комната · ' + roomCode;
      card.appendChild(room);
    }
    const actions = document.createElement('div');
    actions.className = 'cb-dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cb-dialog-cancel';
    cancel.textContent = cancelText;
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'cb-dialog-accept';
    accept.textContent = acceptText;
    actions.append(cancel, accept);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.classList.add('cb-dialog-closing');
      setTimeout(() => overlay.remove(), 160);
      resolve(value);
    };
    const onKey = e => { if (e.key === 'Escape') finish(false); };
    cancel.addEventListener('click', () => finish(false));
    accept.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(false); });
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => overlay.classList.add('cb-dialog-visible'));
    accept.focus();
  });
}

function cbStartPresence() {
  if (!cbSupabase || !cbAuthUser || cbPresenceChannel) return;
  cbPresenceChannel = cbSupabase.channel('cobrowser-online-presence', {
    config: { presence: { key: cbAuthUser.id }, broadcast: { self: false } }
  });
  cbPresenceChannel
    .on('presence', { event: 'sync' }, cbPresenceSnapshot)
    .on('presence', { event: 'join' }, cbPresenceSnapshot)
    .on('presence', { event: 'leave' }, cbPresenceSnapshot)
    .on('broadcast', { event: 'room-invite' }, async ({payload}) => {
      if (payload?.to !== cbAuthUser.id) return;
      const friend = friendsList.find(f => f.supabaseId === payload.from);
      const accepted = await cbShowRoomDialog({
        title: 'Приглашение в комнату',
        message: 'Приглашает тебя посмотреть фильм вместе.',
        name: payload.from_name || friend?.name || 'Друг',
        avatar: friend?.avatar || '',
        roomCode: payload.room_code,
        acceptText: 'Войти в комнату'
      });
      if (accepted) {
        cbPresenceChannel.send({type:'broadcast',event:'room-invite-accepted',payload:{to:payload.from,room_code:payload.room_code}});
        startRoom(payload.room_code, false);
      }
    })
    .on('broadcast', { event: 'room-join-request' }, async ({payload}) => {
      if (payload?.to !== cbAuthUser.id || !isHost() || !activeRoomId) return;
      const friend = friendsList.find(f => f.supabaseId === payload.from);
      const accepted = await cbShowRoomDialog({
        title: 'Запрос на вход',
        message: 'Хочет присоединиться к просмотру в твоей комнате.',
        name: payload.from_name || friend?.name || 'Друг',
        avatar: friend?.avatar || '',
        roomCode: activeRoomId,
        acceptText: 'Разрешить вход'
      });
      if (accepted) {
        cbPresenceChannel.send({type:'broadcast',event:'room-invite',payload:{to:payload.from,from:cbAuthUser.id,from_name:currentUser.name,room_code:activeRoomId}});
      }
    })
    .on('broadcast', { event: 'room-invite-accepted' }, ({payload}) => {
      if (payload?.to === cbAuthUser.id) cbNotice('Друг принял приглашение и подключается к комнате.');
    })
    .subscribe(async status => {
      if (status === 'SUBSCRIBED') {
        cbPresenceReady = true;
        await cbTrackPresence();
        cbPresenceSnapshot();
      }
    });
}
function cbOpenRoomInvitePicker() {
  if (!activeRoomId) return cbNotice('Сначала войди в комнату.');
  if (!isHost()) return cbNotice('Приглашать друзей может только создатель комнаты.');
  if (!cbAuthUser || !cbPresenceChannel || !cbPresenceReady) {
    return cbNotice('Подключение к списку друзей ещё не готово. Подожди немного и попробуй снова.');
  }
  const old = document.querySelector('.cb-dialog-overlay');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.className = 'cb-dialog-overlay cb-dialog-visible';
  const card = document.createElement('div');
  card.className = 'cb-dialog-card cb-invite-picker';
  const heading = document.createElement('h3');
  heading.textContent = 'Пригласить друга';
  const desc = document.createElement('p');
  desc.className = 'cb-dialog-message';
  desc.textContent = 'Выбери друга, которому отправить приглашение в комнату ' + activeRoomId + '.';
  const list = document.createElement('div');
  list.className = 'cb-invite-friend-list';
  if (!friendsList.length) {
    const empty = document.createElement('div');
    empty.className = 'cb-invite-empty';
    empty.textContent = 'Пока нет друзей. Добавь их во вкладке «Друзья».';
    list.appendChild(empty);
  }
  friendsList.forEach(friend => {
    if (!friend.supabaseId) return;
    const online = Boolean(cbPresenceUsers[friend.supabaseId]);
    const item = document.createElement('div');
    item.className = 'cb-invite-friend';
    const avatar = document.createElement('img');
    avatar.src = getValidAvatar(friend.avatar, friend.name);
    avatar.alt = '';
    const info = document.createElement('div');
    info.className = 'cb-invite-friend-info';
    const name = document.createElement('strong');
    name.textContent = friend.name || 'Друг';
    const status = document.createElement('small');
    status.textContent = online ? '● В сети' : '○ Не в сети';
    status.className = online ? 'is-online' : 'is-offline';
    info.append(name, status);
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'btn-small ' + (online ? 'btn-primary' : 'btn-secondary');
    send.textContent = online ? 'Пригласить' : 'Не в сети';
    send.disabled = !online;
    send.addEventListener('click', async () => {
      send.disabled = true;
      send.textContent = 'Отправка…';
      await cbInviteFriendToRoom(friend);
      overlay.remove();
    });
    item.append(avatar, info, send);
    list.appendChild(item);
  });
  const actions = document.createElement('div');
  actions.className = 'cb-dialog-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'cb-dialog-cancel';
  close.textContent = 'Закрыть';
  close.addEventListener('click', () => overlay.remove());
  actions.appendChild(close);
  card.append(heading, desc, list, actions);
  overlay.appendChild(card);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape' && overlay.isConnected) overlay.remove();
    if (!overlay.isConnected) document.removeEventListener('keydown', onEsc);
  });
  document.body.appendChild(overlay);
}

document.getElementById('invite-friend-room-btn')?.addEventListener('click', cbOpenRoomInvitePicker);

async function cbInviteFriendToRoom(friend) {
  const online = cbPresenceUsers[friend.supabaseId];
  if (!online) return cbNotice('Друг сейчас не в сети.');
  if (!activeRoomId || !isHost()) return cbNotice('Приглашать друзей может только создатель активной комнаты.');
  const {error} = await cbPresenceChannel.send({type:'broadcast',event:'room-invite',payload:{
    to:friend.supabaseId,from:cbAuthUser.id,from_name:currentUser.name,room_code:activeRoomId
  }});
  if (error) return cbNotice('Не удалось отправить приглашение: '+error.message);
  cbNotice('Приглашение отправлено '+friend.name+'.');
}
async function cbAskToJoinRoom(friend) {
  const online = cbPresenceUsers[friend.supabaseId];
  if (!online?.in_room) return cbNotice('Друг сейчас не находится в комнате.');
  if (online.is_host) {
    const {error}=await cbPresenceChannel.send({type:'broadcast',event:'room-join-request',payload:{
      to:friend.supabaseId,from:cbAuthUser.id,from_name:currentUser.name,room_code:online.room_code
    }});
    if(error)return cbNotice('Не удалось отправить запрос: '+error.message);
    return cbNotice('Запрос на вход отправлен создателю комнаты.');
  }
  return cbNotice('Друг в комнате, но запросить вход можно только у её создателя.');
}
