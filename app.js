const PEER_PREFIX = 'cobrowser_v1_';

let currentUser = JSON.parse(localStorage.getItem('cobrowser_user')) || null;
let avatarSeed = currentUser ? currentUser.seed : Math.random().toString(36).substring(7);

let peer = null;
let connections = new Map(); // peerId -> DataConnection (используется Хостом)
let hostConn = null;        // DataConnection к Хосту (используется гостем)

let roomState = {
  id: null,
  hostPeerId: null,
  controllerPeerId: null,
  browserUrl: '',
  users: [] // { peerId, name, avatar }
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

// --- 1. ПРОФИЛЬ ---
const avatarImg = document.getElementById('avatar-img');
const usernameInput = document.getElementById('username-input');

function updateAvatarPreview() {
  avatarImg.src = `https://api.dicebear.com/7.x/bottts/svg?seed=${avatarSeed}`;
}

document.getElementById('random-avatar-btn').onclick = () => {
  avatarSeed = Math.random().toString(36).substring(7);
  updateAvatarPreview();
};

document.getElementById('save-profile-btn').onclick = () => {
  const name = usernameInput.value.trim();
  if (!name) return alert('Введи никнейм!');
  currentUser = {
    id: currentUser?.id || 'u_' + Date.now(),
    name,
    seed: avatarSeed,
    avatar: avatarImg.src
  };
  localStorage.setItem('cobrowser_user', JSON.stringify(currentUser));
  openLobby();
};

document.getElementById('edit-profile-btn').onclick = () => {
  usernameInput.value = currentUser.name;
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
    // Входящее подключение принимает только Главный
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

function handleMessageAtHost(fromPeerId, msg) {
  if (msg.type === 'join') {
    const exists = roomState.users.some(u => u.peerId === msg.user.peerId);
    if (!exists) roomState.users.push(msg.user);
    addSystemMessage(`${msg.user.name} вошёл в комнату`);
    broadcastState();
    updateUI();
  } else if (msg.type === 'chat') {
    const payload = { type: 'chat', sender: msg.sender, text: msg.text };
    broadcastRaw(payload);
    appendChatMessage(msg.sender, msg.text);
  } else if (msg.type === 'set-url' && fromPeerId === roomState.controllerPeerId) {
    roomState.browserUrl = msg.url;
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

  // Менять URL может Главный или тот, у кого сейчас пульт
  browserControls.style.display = (isHost() || hasControl()) ? 'flex' : 'none';

  // Если нет прав управления — ставим щит поверх браузера
  if (hasControl()) {
    shield.classList.add('hidden');
  } else {
    shield.classList.remove('hidden');
  }

  // Синхронизируем URL браузера
  if (roomState.browserUrl) {
    loadVirtualBrowser(roomState.browserUrl);
  }

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

    // Главный может передать или забрать пульт
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

// --- 3. ВСТРОЕННЫЙ БРАУЗЕР ---
const iframe = document.getElementById('virtual-browser-frame');
const placeholder = document.getElementById('browser-placeholder');

function normalizeUrl(url) {
  if (!url) return '';
  return url.startsWith('http://') || url.startsWith('https://') ? url : 'https://' + url;
}

function loadVirtualBrowser(url) {
  const cleanUrl = normalizeUrl(url);
  if (!cleanUrl) return;
  placeholder.classList.add('hidden');
  iframe.style.display = 'block';
  if (iframe.src !== cleanUrl) {
    iframe.src = cleanUrl;
  }
}

function publishBrowserUrl(url) {
  const cleanUrl = normalizeUrl(url.trim());
  if (!cleanUrl) return;

  if (isHost()) {
    roomState.browserUrl = cleanUrl;
    loadVirtualBrowser(cleanUrl);
    broadcastState();
  } else if (hasControl() && hostConn && hostConn.open) {
    hostConn.send({ type: 'set-url', url: cleanUrl });
  }
}

document.getElementById('connect-browser-btn').onclick = () => {
  publishBrowserUrl(document.getElementById('neko-url-input').value);
};

document.getElementById('demo-browser-btn').onclick = () => {
  publishBrowserUrl('https://ru.wikipedia.org');
};

// --- 4. ЧАТ ---
const chatMessages = document.getElementById('chat-messages');

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<em style="color:var(--muted)">${text}</em>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendChatMessage(sender, text) {
  const div = document.createElement('div');
  div.className = 'msg';
  const strong = document.createElement('strong');
  strong.textContent = sender;
  div.appendChild(strong);
  div.appendChild(document.createTextNode(text));
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

document.getElementById('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  if (isHost()) {
    broadcastRaw({ type: 'chat', sender: currentUser.name, text });
    appendChatMessage(currentUser.name, text);
  } else if (hostConn && hostConn.open) {
    hostConn.send({ type: 'chat', sender: currentUser.name, text });
    appendChatMessage(currentUser.name, text);
  } else {
    appendChatMessage(currentUser.name, text);
  }
  input.value = '';
};

if (currentUser) {
  openLobby();
} else {
  updateAvatarPreview();
  showScreen('profile');
}
