
/* Depende de: config.js (db); state.js (currentUser, profilesCache, onlineUsersMap,
   activeConversationId, activeRecipientProfile, replyingToMessageId, replyingToSnippet,
   cachedConversationsList, dmSearchTimer); utils.js (formatDate, createAvatarNode,
   setAvatarContent)
   En tiempo de ejecución usa funciones de otros módulos: openPublicProfile (profile.js)
   Expone: checkGlobalUnreadMessages, loadConversations, renderConversationsDOM,
   searchUsersForChat, openDirectChatWithUser, openChatRoom, buildChatMessageNode,
   appendChatMessageNode, scrollToBottomChat, triggerReplyToMessage, cancelReply,
   sendChatMessage, openChatDetailsPage, toggleChatDetailsMenu, handleChatActionMenu,
   openChatRecipientProfile, triggerChatSearch, openMuteOptionsModal, openChatSubSettings */

async function checkGlobalUnreadMessages() {
 if (!currentUser) return;
 const { data: parts } = await db.from('conversation_participants').select('conversation_id, last_read_at').eq('user_id', currentUser.id);
 if (!parts || !parts.length) return;

 for (const p of parts) {
  const { data: latest } = await db.from('messages')
   .select('created_at, sender_id')
   .eq('conversation_id', p.conversation_id)
   .order('created_at', { ascending: false })
   .limit(1)
   .maybeSingle();

  if (latest && latest.sender_id !== currentUser.id) {
   if (!p.last_read_at || new Date(latest.created_at) > new Date(p.last_read_at)) {
    document.getElementById('navUnreadDot').classList.add('active');
    return;
   }
  }
 }
 document.getElementById('navUnreadDot').classList.remove('active');
}

async function loadConversations() {
 const container = document.getElementById('dmConversationsList');
 if (!currentUser) return;

 try {
  const { data: myParts } = await db.from('conversation_participants').select('conversation_id, last_read_at').eq('user_id', currentUser.id);
  if (!myParts || !myParts.length) {
   container.innerHTML = '<div class="activity-empty">No tenés conversaciones activas.</div>';
   return;
  }

  const convIds = myParts.map(p => p.conversation_id);
  const { data: allParts } = await db.from('conversation_participants').select('conversation_id, user_id').in('conversation_id', convIds);

  const convMap = {};
  convIds.forEach(id => { convMap[id] = { otherUserId: null, last_read_at: myParts.find(p => p.conversation_id === id)?.last_read_at }; });
  (allParts || []).forEach(p => { if (p.user_id !== currentUser.id && convMap[p.conversation_id]) convMap[p.conversation_id].otherUserId = p.user_id; });

  const otherUserIds = [...new Set(Object.values(convMap).map(c => c.otherUserId).filter(Boolean))];
  const missing = otherUserIds.filter(id => !profilesCache[id]);
  if (missing.length > 0) {
   const { data: profs } = await db.from('og_profiles').select('id, username, display_name, avatar_url').in('id', missing);
   (profs || []).forEach(p => profilesCache[p.id] = p);
  }

  const conversationsList = await Promise.all(convIds.map(async convId => {
   const otherId = convMap[convId].otherUserId;
   const profile = profilesCache[otherId];
   if (!profile) return null;

   const { data: lastMsg } = await db.from('messages')
    .select('content, created_at, sender_id')
    .eq('conversation_id', convId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

   const isUnread = lastMsg && lastMsg.sender_id !== currentUser.id && (!convMap[convId].last_read_at || new Date(lastMsg.created_at) > new Date(convMap[convId].last_read_at));

   return {
    conversationId: convId,
    profile,
    lastMessage: lastMsg ? lastMsg.content : 'Conversación iniciada',
    time: lastMsg ? formatDate(lastMsg.created_at) : '',
    timestamp: lastMsg ? new Date(lastMsg.created_at).getTime() : 0,
    isUnread
   };
  }));

  const valid = conversationsList.filter(Boolean);
  valid.sort((a, b) => b.timestamp - a.timestamp);
  renderConversationsDOM(valid, container);
 } catch (e) {
  container.innerHTML = '<div class="activity-empty">Error al cargar conversaciones.</div>';
 }
}

function renderConversationsDOM(conversationsList, container) {
 if (!conversationsList.length) {
  container.innerHTML = '<div class="activity-empty">No hay conversaciones recientes.</div>';
  return;
 }
 const fragment = document.createDocumentFragment();

 conversationsList.forEach(item => {
  const row = document.createElement('div');
  row.className = 'dm-conv-item';
  row.onclick = () => openChatRoom(item.conversationId, item.profile);

  const av = createAvatarNode(item.profile, false);
  av.className += ' dm-conv-avatar';

  const info = document.createElement('div');
  info.className = 'dm-conv-info';
  info.innerHTML = `<div class="dm-conv-name"><span>${item.profile.display_name || item.profile.username}</span><span class="dm-conv-time">${item.time}</span></div><div class="dm-conv-snippet">${item.lastMessage}</div>`;

  if (item.isUnread) {
   const dot = document.createElement('span');
   dot.className = 'dm-unread-dot';
   info.append(dot);
  }
  row.append(av, info);
  fragment.append(row);
 });
 container.replaceChildren(fragment);
}

async function searchUsersForChat() {
 clearTimeout(dmSearchTimer);
 const val = document.getElementById('dmSearchInput').value.trim();
 const resultBox = document.getElementById('dmSearchResults');
 if (val.length < 2) { resultBox.replaceChildren(); return; }

 dmSearchTimer = setTimeout(async () => {
  const { data } = await db.from('og_profiles').select('id, username, display_name, avatar_url').ilike('username', '%' + val + '%').limit(10);
  if (!data || !data.length) {
   resultBox.innerHTML = '<p class="muted" style="text-align:center;padding:10px">No se encontraron usuarios.</p>';
   return;
  }

  const fragment = document.createDocumentFragment();
  data.forEach(profile => {
   if (profile.id === currentUser?.id) return;
   profilesCache[profile.id] = profile;
   const item = document.createElement('div');
   item.className = 'public-user';
   item.append(createAvatarNode(profile, false));
   const info = document.createElement('div');
   info.className = 'public-user-info';
   info.innerHTML = `<strong>${profile.display_name || profile.username}</strong><small>@${profile.username}</small>`;
   item.append(info);
   item.onclick = () => openDirectChatWithUser(profile.id);
   fragment.append(item);
  });
  resultBox.replaceChildren(fragment);
 }, 200);
}

async function openDirectChatWithUser(recipientId) {
 if (!currentUser || !recipientId) return;
 const { data: convId } = await db.rpc('get_or_create_conversation', { user_a: currentUser.id, user_b: recipientId });
 const profile = profilesCache[recipientId] || (await db.from('og_profiles').select('*').eq('id', recipientId).single()).data;
 if (profile) {
  profilesCache[recipientId] = profile;
  openChatRoom(convId, profile);
 }
}

async function openChatRoom(conversationId, recipientProfile) {
 activeConversationId = conversationId;
 activeRecipientProfile = recipientProfile;
 cancelReply();

 document.querySelectorAll('main>div').forEach(x => x.classList.remove('active'));
 document.getElementById('chatRoomPage').classList.add('active');

 const bottomNavBar = document.getElementById('bottomNavBar');
 if (bottomNavBar) bottomNavBar.style.display = 'none';

 document.getElementById('chatRoomTitle').textContent = recipientProfile.display_name || recipientProfile.username;

 const headerAvatar = document.getElementById('chatRoomHeaderAvatar');
 headerAvatar.replaceChildren();
 if (recipientProfile.avatar_url) {
  const img = document.createElement('img');
  img.src = recipientProfile.avatar_url;
  headerAvatar.append(img);
 } else {
  headerAvatar.textContent = '👤';
 }
 const dot = document.createElement('span');
 dot.id = 'chatRoomOnlineDot';
 dot.className = 'online-dot';
 if (onlineUsersMap[recipientProfile.id]) dot.classList.add('active');
 headerAvatar.append(dot);

 document.getElementById('chatRoomStatusSub').textContent = onlineUsersMap[recipientProfile.id] ? 'En línea' : 'Desconectado';

 await db.from('conversation_participants').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', conversationId).eq('user_id', currentUser.id);
 checkGlobalUnreadMessages();

 const container = document.getElementById('chatMessagesContainer');
 container.innerHTML = '<div class="activity-empty">Cargando mensajes...</div>';

 const { data: msgs } = await db.from('messages').select('*').eq('conversation_id', conversationId).order('created_at', { ascending: true });
 container.replaceChildren();
 if (msgs && msgs.length) {
  const fragment = document.createDocumentFragment();
  msgs.forEach(m => fragment.append(buildChatMessageNode(m)));
  container.replaceChildren(fragment);
  scrollToBottomChat();
 }
}

function buildChatMessageNode(msg) {
 const isMine = msg.sender_id === currentUser.id;
 const bubble = document.createElement('div');
 bubble.className = `chat-bubble ${isMine ? 'sent' : 'received'}`;
 bubble.onclick = () => triggerReplyToMessage(msg.id, msg.content);

 if (msg.reply_to_snippet) {
  const rep = document.createElement('div');
  rep.className = 'chat-bubble-reply-preview';
  rep.textContent = msg.reply_to_snippet;
  bubble.append(rep);
 }

 const textDiv = document.createElement('div');
 textDiv.textContent = msg.content;
 bubble.append(textDiv);

 const timeDiv = document.createElement('div');
 timeDiv.className = 'chat-bubble-time';
 timeDiv.textContent = new Date(msg.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
 bubble.append(timeDiv);

 return bubble;
}

function appendChatMessageNode(msg) {
 const container = document.getElementById('chatMessagesContainer');
 container.append(buildChatMessageNode(msg));
}

function scrollToBottomChat() {
 const container = document.getElementById('chatMessagesContainer');
 container.scrollTop = container.scrollHeight;
}

function triggerReplyToMessage(msgId, content) {
 replyingToMessageId = msgId;
 replyingToSnippet = content.slice(0, 45) + (content.length > 45 ? '...' : '');
 document.getElementById('replyingTextSnippet').textContent = replyingToSnippet;
 document.getElementById('replyingBar').classList.add('active');
 document.getElementById('chatMessageInput').focus();
}

function cancelReply() {
 replyingToMessageId = null;
 replyingToSnippet = null;
 document.getElementById('replyingBar').classList.remove('active');
}

async function sendChatMessage() {
 if (!activeConversationId || !currentUser) return;
 const input = document.getElementById('chatMessageInput');
 const text = input.value.trim();
 if (!text) return;

 input.value = '';
 const payload = {
  conversation_id: activeConversationId,
  sender_id: currentUser.id,
  content: text,
  reply_to_id: replyingToMessageId,
  reply_to_snippet: replyingToSnippet
 };
 cancelReply();

 const { data: inserted } = await db.from('messages').insert(payload).select().single();
 if (inserted) {
  appendChatMessageNode(inserted);
  scrollToBottomChat();
  cachedConversationsList = null;
 }
}

function openChatDetailsPage() {
 if (!activeRecipientProfile) return;
 document.querySelectorAll('main>div').forEach(x => x.classList.remove('active'));
 document.getElementById('chatDetailsPage').classList.add('active');

 const av = document.getElementById('chatDetailsAvatarContainer');
 setAvatarContent(av, activeRecipientProfile.avatar_url, '👤');
 document.getElementById('chatDetailsName').textContent = activeRecipientProfile.display_name || activeRecipientProfile.username;
 document.getElementById('chatDetailsUsername').textContent = '@' + activeRecipientProfile.username;

 const isOnline = onlineUsersMap[activeRecipientProfile.id];
 const statusEl = document.getElementById('chatDetailsActivityStatus');
 statusEl.textContent = isOnline ? 'En línea' : 'Desconectado';
 statusEl.style.color = isOnline ? '#22c55e' : '#888888';
}

function toggleChatDetailsMenu() {
 const dd = document.getElementById('chatDetailsDropdown');
 dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
}

function handleChatActionMenu(action) {
 document.getElementById('chatDetailsDropdown').style.display = 'none';
 if (action === 'block') alert('Usuario bloqueado.');
 if (action === 'report') alert('Reporte enviado.');
 if (action === 'restrict') alert('Cuenta restringida.');
}

function openChatRecipientProfile() {
 if (activeRecipientProfile) openPublicProfile(activeRecipientProfile.id);
}

function triggerChatSearch() {
 const query = prompt('Buscar mensaje en el chat:');
 if (!query) return;
 alert(`Buscando "${query}" en el historial...`);
}

function openMuteOptionsModal() { alert('Notificaciones del chat silenciadas.'); }

function openChatSubSettings(type) {
 document.querySelectorAll('main>div').forEach(x => x.classList.remove('active'));
 document.getElementById('chatSubSettingsPage').classList.add('active');

 const titleEl = document.getElementById('chatSubSettingsTitle');
 const bodyEl = document.getElementById('chatSubSettingsBody');
 bodyEl.replaceChildren();

 if (type === 'privacy') {
  titleEl.textContent = 'Privacidad y seguridad';
  bodyEl.innerHTML = `<div class="settings-row"><div class="settings-row-info"><p class="settings-row-title">Confirmaciones de lectura</p><p class="settings-row-desc">Mostrar cuando leés los mensajes.</p></div><label class="toggle-switch"><input type="checkbox" checked><span class="toggle-slider"></span></label></div>`;
 } else if (type === 'timer') {
  titleEl.textContent = 'Mensajes temporales';
  bodyEl.innerHTML = `<p class="muted">Los mensajes enviados desaparecerán automáticamente después del tiempo seleccionado.</p><button class="secondary" onclick="alert('Temporizador desactivado')">Desactivado</button><button class="secondary" onclick="alert('Configurado a 24 horas')">24 horas</button><button class="secondary" onclick="alert('Configurado a 7 días')">7 días</button>`;
 } else if (type === 'nickname') {
  titleEl.textContent = 'Apodos';
  bodyEl.innerHTML = `<input class="field" id="nicknameInput" placeholder="Nuevo apodo"><button class="primary" onclick="alert('Apodo actualizado')">Guardar apodo</button>`;
 } else if (type === 'style') {
  titleEl.textContent = 'Personalizar estilo';
  bodyEl.innerHTML = `<p class="muted">Tema actual: Minimalista Blanco</p><button class="secondary" onclick="alert('Tema azul clásico aplicado')">Azul Clásico</button><button class="secondary" onclick="alert('Tema monocromo aplicado')">Monocromo</button>`;
 }
}
