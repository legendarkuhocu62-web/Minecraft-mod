const PEER_PREFIX = 'cobrowser_v1_';
const RU_PROXY_PREFIX = '';

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

  // Если знаем прямой peerId — шлём напрямую
  if (targetUser.peerId) {
    sendDirectPeerMessage(targetUser.peerId, reqPayload);
  }
  // Если в комнате — можно маршрутизировать через хоста по userId/peerId
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
    await cbLoadSocial();
    cbSubscribeSocial();
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
    const p = await cbSupabase.from('profiles').select('id,public_id,name,avatar').in('id', ids);
    if (p.error) throw p.error;
    profiles = p.data;
  }
  const byId = new Map(profiles.map(p=>[p.id,p]));
  friendRequests = incoming.data.map(r=>({...byId.get(r.sender_id), requestId:r.id, userId:byId.get(r.sender_id)?.public_id}));
  outgoingRequests = outgoing.data.map(r=>({...byId.get(r.receiver_id), requestId:r.id}));
  friendsList = links.data.map(r=>byId.get(r.user_a===uid?r.user_b:r.user_a)).filter(Boolean)
    .map(p=>({userId:p.public_id,name:p.name,avatar:p.avatar,supabaseId:p.id}));
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
  const panel=document.createElement('div');
  panel.id='personal-chat-panel';
  panel.className='personal-chat-panel';
  panel.innerHTML=`<h3>Личные сообщения</h3><div class="dm-layout"><div id="dm-friends" class="dm-friends"><p class="friend-sub">Добавь друга, чтобы начать переписку</p></div><div class="dm-conversation"><div id="dm-title" class="dm-title">Выбери друга</div><div id="dm-messages" class="dm-messages"></div><form id="dm-form" class="dm-form"><input id="dm-input" maxlength="2000" placeholder="Личное сообщение..." autocomplete="off"><button type="submit">➤</button></form></div></div>`;
  const friendsPanel=document.getElementById('lobby-tab-friends');
  if(friendsPanel) friendsPanel.appendChild(panel);
  const style=document.createElement('style');
  style.textContent=`#social-status{font-size:.75rem;color:var(--muted);margin-top:.5rem}.personal-chat-panel{margin-top:1.4rem;padding-top:1rem;border-top:1px solid var(--border,#444)}.dm-layout{display:grid;grid-template-columns:minmax(110px, .7fr) 1.5fr;gap:.7rem;min-height:260px}.dm-friends,.dm-conversation{min-width:0;border:1px solid var(--border,#444);border-radius:10px;padding:.5rem}.dm-friend{display:block;width:100%;text-align:left;margin:.2rem 0;padding:.55rem;border:0;border-radius:7px;background:var(--surface-2,#333);color:inherit;cursor:pointer}.dm-friend.active{outline:2px solid var(--accent,#7c8cff)}.dm-title{font-weight:600;padding:.35rem;border-bottom:1px solid var(--border,#444)}.dm-messages{height:190px;overflow:auto;padding:.5rem}.dm-message{padding:.35rem .5rem;margin:.3rem 0;border-radius:8px;background:var(--surface-2,#333);overflow-wrap:anywhere}.dm-message.mine{margin-left:12%;background:var(--accent-soft,#343b58)}.dm-form{display:flex;gap:.4rem}.dm-form input{min-width:0;flex:1}@media(max-width:600px){.dm-layout{grid-template-columns:1fr}.dm-friends{max-height:110px;overflow:auto}.dm-messages{height:160px}}`;
  document.head.appendChild(style);
  document.getElementById('dm-form').onsubmit=async e=>{
    e.preventDefault(); const input=document.getElementById('dm-input'); const body=input.value.trim();
    if(!body||!cbSelectedFriend) return;
    const {error}=await cbSupabase.from('direct_messages').insert({sender_id:cbAuthUser.id,receiver_id:cbSelectedFriend.supabaseId,body});
    if(error) return cbNotice('Не удалось отправить сообщение: '+error.message);
    input.value=''; await cbLoadDirectMessages();
  };
}
function cbRenderDmFriends() {
  const el=document.getElementById('dm-friends'); if(!el)return;
  el.innerHTML='';
  if(!friendsList.length){el.innerHTML='<p class="friend-sub">Пока нет друзей</p>';return;}
  friendsList.forEach(f=>{
    const b=document.createElement('button'); b.className='dm-friend'+(cbSelectedFriend?.supabaseId===f.supabaseId?' active':'');
    b.textContent=f.name; b.onclick=()=>{cbSelectedFriend=f;cbRenderDmFriends();cbLoadDirectMessages();};
    el.appendChild(b);
  });
}
async function cbLoadDirectMessages() {
  if(!cbSelectedFriend||!cbSupabase)return;
  document.getElementById('dm-title').textContent='Переписка с '+cbSelectedFriend.name;
  const uid=cbAuthUser.id, other=cbSelectedFriend.supabaseId;
  const {data,error}=await cbSupabase.from('direct_messages').select('id,sender_id,receiver_id,body,created_at')
    .or(`and(sender_id.eq.${uid},receiver_id.eq.${other}),and(sender_id.eq.${other},receiver_id.eq.${uid})`)
    .order('created_at',{ascending:true}).limit(300);
  if(error){cbSetSocialStatus('Ошибка загрузки переписки: '+error.message);return;}
  const el=document.getElementById('dm-messages');el.innerHTML='';
  (data||[]).forEach(m=>{const d=document.createElement('div');d.className='dm-message'+(m.sender_id===uid?' mine':'');d.textContent=m.body;el.appendChild(d);});
  el.scrollTop=el.scrollHeight;
}
function cbOverrideFriendUI() {
  const add=document.getElementById('add-friend-manual-btn');
  if(add)add.onclick=async()=>{const input=document.getElementById('friend-name-input');await cbSendFriendRequest(input.value);input.value='';};
  window.acceptFriendRequest=cbAcceptRequest;
  // Existing renderers are replaced so database request IDs are used.
  window.renderFriendRequests=function(){
    const list=document.getElementById('friend-requests-list'), count=document.getElementById('requests-count'), badge=document.getElementById('friend-req-badge');
    if(!list)return;count.textContent=friendRequests.length;badge.textContent=friendRequests.length;badge.classList.toggle('hidden',!friendRequests.length);list.innerHTML='';
    if(!friendRequests.length){list.innerHTML='<li class="friend-sub">Входящих предложений пока нет</li>';return;}
    friendRequests.forEach(r=>{const li=document.createElement('li');li.className='friend-item';const meta=document.createElement('div');meta.className='friend-meta';const n=document.createElement('div');n.className='friend-name';n.textContent=r.name;const sub=document.createElement('div');sub.className='friend-sub';sub.textContent='ID: '+r.public_id;meta.append(n,sub);const actions=document.createElement('div');actions.className='friend-actions';const ok=document.createElement('button');ok.className='btn-primary btn-small';ok.textContent='Принять';ok.onclick=()=>cbAcceptRequest(r.requestId);const no=document.createElement('button');no.className='btn-secondary btn-small';no.textContent='✕';no.onclick=()=>cbDeclineRequest(r.requestId);actions.append(ok,no);li.append(meta,actions);list.append(li);});
  };
  window.renderFriends=function(){
    const list=document.getElementById('friends-list'),count=document.getElementById('friends-count');if(!list)return;count.textContent=friendsList.length;list.innerHTML='';
    if(!friendsList.length){list.innerHTML='<li class="friend-sub">Пока нет друзей</li>';return;}
    friendsList.forEach(f=>{const li=document.createElement('li');li.className='friend-item';const meta=document.createElement('div');meta.className='friend-meta';const n=document.createElement('div');n.className='friend-name';n.textContent=f.name;const sub=document.createElement('div');sub.className='friend-sub';sub.textContent='ID: '+f.userId;meta.append(n,sub);li.append(meta);list.append(li);});
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
  // Дождаться анонимной авторизации и сохранить публичный профиль в облако.
  for(let i=0;i<30&&!cbAuthUser;i++) await new Promise(r=>setTimeout(r,200));
  if(cbAuthUser) await cbRefreshProfile();
};
cbInit();
