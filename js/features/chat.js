/* Depende de: config.js (db); state.js (currentUser, profilesCache, onlineUsersMap,
   activeConversationId, activeRecipientProfile, replyingToMessageId, replyingToSnippet,
   cachedConversationsList, renderedMessageIds, prefetchedConversationIds,
   prefetchedMessagesByConv, dmSearchTimer); utils.js (formatDate, createAvatarNode,
   setAvatarContent, ogCache, setCachedProfile, prefetchConversationMessages,
   bindSmartPrefetch, PROFILE_SELECT_FIELDS, PROFILE_MINI_FIELDS)
   En tiempo de ejecución usa funciones de otros módulos: openPublicProfile (profile.js)
   Expone: checkGlobalUnreadMessages, loadConversations, renderConversationsDOM,
   searchUsersForChat, openDirectChatWithUser, openChatRoom, buildChatMessageNode,
   appendChatMessageNode, scrollToBottomChat, triggerReplyToMessage, cancelReply,
   sendChatMessage, openChatDetailsPage, toggleChatDetailsMenu, handleChatActionMenu,
   openChatRecipientProfile, triggerChatSearch, openMuteOptionsModal, openChatSubSettings */

const MESSAGE_SELECT_FIELDS = 'id, conversation_id, sender_id, content, reply_to_id, reply_to_snippet, created_at';

async function checkGlobalUnreadMessages() {
 if (!currentUser) return;
 const { data: parts } = await db.from('conversation_participants')
  .select('conversation_id, last_read_at')
  .eq('user_id', currentUser.id);
 if (!parts || !parts.length) {
  document.getElementById('navUnreadDot')?.classList.remove('active');
  return;
 }

 const convIds = parts.map(p => p.conversation_id);
 // Eliminar N+1: traer mensajes recientes de todas las conversaciones en 1 sola consulta
 const { data: recentMsgs } = await db.from('messages')
  .select('conversation_id, created_at, sender_id')
  .in('conversation_id', convIds)
  .order('created_at', { ascending: false })
  .limit(Math.max(convIds.length * 4, 30));

 const latestByConv = {};
 (recentMsgs || []).forEach(m => {
  if (!latestByConv[m.conversation_id]) latestByConv[m.conversation_id] = m;
 });

 for (const p of parts) {
  const latest = latestByConv[p.conversation_id];
  if (latest && latest.sender_id !== currentUser.id) {
   if (!p.last_read_at || new Date(latest.created_at) > new Date(p.last_read_at)) {
    document.getElementById('navUnreadDot')?.classList.add('active');
    return;
   }
  }
 }
 document.getElementById('navUnreadDot')?.classList.remove('active');
}

async function loadConversations() {
 const container = document.getElementById('dmConversationsList');
 if (!currentUser) return;

 if (!cachedConversationsList) {
  const cached = ogCache.get('conversations', 1000 * 60 * 60 * 12);
  if (Array.isArray(cached)) cachedConversationsList = cached;
 }
 if (Array.isArray(cachedConversationsList)) {
  renderConversationsDOM(cachedConversationsList, container);
 }

 try {
  const { data: myParts } = await db.from('conversation_participants')
   .select('conversation_id, last_read_at')
   .eq('user_id', currentUser.id);

  if (!myParts || !myParts.length) {
   cachedConversationsList = [];
   ogCache.set('conversations', []);
   container.innerHTML = '<div class="activity-empty">No tenés conversaciones activas.</div>';
   return;
  }

  const convIds = myParts.map(p => p.conversation_id);

  // Batch paralelo: participantes + últimos mensajes de todas las conversaciones en 2 únicas consultas
  const [allPartsRes, recentMsgsRes] = await Promise.all([
   db.from('conversation_participants').select('conversation_id, user_id').in('conversation_id', convIds),
   db.from('messages')
    .select('conversation_id, content, created_at, sender_id')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: false })
    .limit(Math.max(convIds.length * 4, 40))
  ]);

  const convMap = {};
  myParts.forEach(p => {
   convMap[p.conversation_id] = { otherUserId: null, last_read_at: p.last_read_at };
  });
  (allPartsRes.data || []).forEach(p => {
   if (p.user_id !== currentUser.id && convMap[p.conversation_id]) {
    convMap[p.conversation_id].otherUserId = p.user_id;
   }
  });

  const latestMsgByConv = {};
  (recentMsgsRes.data || []).forEach(m => {
   if (!latestMsgByConv[m.conversation_id]) latestMsgByConv[m.conversation_id] = m;
  });

  const otherUserIds = [...new Set(Object.values(convMap).map(c => c.otherUserId).filter(Boolean))];
  const missing = otherUserIds.filter(id => !profilesCache[id]);
  if (missing.length > 0) {
   const { data: profs } = await db.from('og_profiles').select(PROFILE_MINI_FIELDS).in('id', missing);
   (profs || []).forEach(p => setCachedProfile(p, false));
   ogCache.set('profiles_map', profilesCache);
  }

  const valid = convIds.map(convId => {
   const otherId = convMap[convId]?.otherUserId;
   const profile = profilesCache[otherId];
   if (!profile) return null;

   const lastMsg = latestMsgByConv[convId] || null;
   const isUnread = Boolean(
    lastMsg &&
    lastMsg.sender_id !== currentUser.id &&
    (!convMap[convId].last_read_at || new Date(lastMsg.created_at) > new Date(convMap[convId].last_read_at))
   );

   return {
    conversationId: convId,
    profile,
    lastMessage: lastMsg ? lastMsg.content : 'Conversación iniciada',
    time: lastMsg ? formatDate(lastMsg.created_at) : '',
    timestamp: lastMsg ? new Date(lastMsg.created_at).getTime() : 0,
    isUnread
   };
  }).filter(Boolean);

  valid.sort((a, b) => b.timestamp - a.timestamp);
  cachedConversationsList = valid;
  ogCache.set('conversations', valid);
  renderConversationsDOM(valid, container);
 } catch (e) {
  if (!cachedConversationsList) {
   container.innerHTML = '<div class="activity-empty">Error al cargar conversaciones.</div>';
  }
 }
}

function renderConversationsDOM(conversationsList, container) {
 if (!conversationsList || !conversationsList.length) {
  container.innerHTML = '<div class="activity-empty">No hay conversaciones recientes.</div>';
  return;
 }
 const fragment = document.createDocumentFragment();

 conversationsList.forEach(item => {
  const row = document.createElement('div');
  row.className = 'dm-conv-item';
  row.onclick = () => openChatRoom(item.conversationId, item.profile);
  bindSmartPrefetch(row, () => prefetchConversationMessages(item.conversationId));

  const av = createAvatarNode(item.profile, false);
  av.className += ' dm-conv-avatar';

  const info = document.createElement('div');
  info.className = 'dm-conv-info';

  const nameRow = document.createElement('div');
  nameRow.className = 'dm-conv-name';
  const nameSpan = document.createElement('span');
  nameSpan.textContent = item.profile.display_name || item.profile.username;
  const timeSpan = document.createElement('span');
  timeSpan.className = 'dm-conv-time';
  timeSpan.textContent = item.time;
  nameRow.append(nameSpan, timeSpan);

  const snippetDiv = document.createElement('div');
  snippetDiv.className = 'dm-conv-snippet';
  snippetDiv.textContent = item.lastMessage;

  info.append(nameRow, snippetDiv);

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
  const { data } = await db.from('og_profiles').select(PROFILE_MINI_FIELDS).ilike('username', '%' + val + '%').limit(10);
  if (!data || !data.length) {
   resultBox.innerHTML = '<p class="muted" style="text-align:center;padding:10px">No se encontraron usuarios.</p>';
   return;
  }

  const fragment = document.createDocumentFragment();
  data.forEach(profile => {
   if (profile.id === currentUser?.id) return;
   setCachedProfile(profile, false);
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
 const profile = profilesCache[recipientId] || (await db.from('og_profiles').select(PROFILE_SELECT_FIELDS).eq('id', recipientId).single()).data;
 if (profile) {
  setCachedProfile(profile, true);
  openChatRoom(convId, profile);
 }
}

function renderChatMessagesList(msgs, container) {
 renderedMessageIds.clear();
 const fragment = document.createDocumentFragment();
 (msgs || []).forEach(m => {
  if (m.id) renderedMessageIds.add(m.id);
  fragment.append(buildChatMessageNode(m));
 });
 container.replaceChildren(fragment);
 scrollToBottomChat();
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
  img.decoding = 'async';
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

 const container = document.getElementById('chatMessagesContainer');
 const cachedMsgs = prefetchedMessagesByConv[conversationId] || ogCache.get(`chat_msgs_${conversationId}`, 1000 * 60 * 60 * 12);
 if (Array.isArray(cachedMsgs) && cachedMsgs.length > 0) {
  renderChatMessagesList(cachedMsgs, container);
 } else {
  renderedMessageIds.clear();
  container.innerHTML = '<div class="activity-empty">Cargando mensajes...</div>';
 }

 const [, msgsRes] = await Promise.all([
  db.from('conversation_participants').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', conversationId).eq('user_id', currentUser.id),
  db.from('messages').select(MESSAGE_SELECT_FIELDS).eq('conversation_id', conversationId).order('created_at', { ascending: true })
 ]);

 checkGlobalUnreadMessages();

 const msgs = msgsRes.data;
 if (activeConversationId !== conversationId) return;
 if (msgs) {
  prefetchedMessagesByConv[conversationId] = msgs;
  ogCache.set(`chat_msgs_${conversationId}`, msgs.slice(-50));
  renderChatMessagesList(msgs, container);
 } else if (!cachedMsgs) {
  container.replaceChildren();
 }
}

function buildChatMessageNode(msg) {
 const isMine = msg.sender_id === currentUser.id;
 const bubble = document.createElement('div');
 bubble.className = `chat-bubble ${isMine ? 'sent' : 'received'}`;
 if (msg.id) bubble.dataset.msgId = msg.id;
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
 if (msg?.id && renderedMessageIds.has(msg.id)) return null;
 if (msg?.id) renderedMessageIds.add(msg.id);
 const container = document.getElementById('chatMessagesContainer');
 const emptyPlaceholder = container.querySelector('.activity-empty');
 if (emptyPlaceholder) emptyPlaceholder.remove();
 const node = buildChatMessageNode(msg);
 container.append(node);
 return node;
}

function scrollToBottomChat() {
 const container = document.getElementById('chatMessagesContainer');
 if (container) container.scrollTop = container.scrollHeight;
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

 const targetConvId = activeConversationId;
 const replyId = replyingToMessageId;
 const replySnippet = replyingToSnippet;

 input.value = '';
 cancelReply();

 // Optimistic UI: insertar burbuja de inmediato (0 ms)
 const tempId = 'optimistic-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
 const optimisticMsg = {
  id: tempId,
  conversation_id: targetConvId,
  sender_id: currentUser.id,
  content: text,
  reply_to_id: replyId,
  reply_to_snippet: replySnippet,
  created_at: new Date().toISOString()
 };
 const optimisticNode = appendChatMessageNode(optimisticMsg);
 scrollToBottomChat();

 const payload = {
  conversation_id: targetConvId,
  sender_id: currentUser.id,
  content: text,
  reply_to_id: replyId,
  reply_to_snippet: replySnippet
 };

 const { data: inserted, error } = await db.from('messages')
  .insert(payload)
  .select(MESSAGE_SELECT_FIELDS)
  .single();

 if (error) {
  if (optimisticNode) {
   optimisticNode.style.opacity = '0.55';
   const timeEl = optimisticNode.querySelector('.chat-bubble-time');
   if (timeEl) timeEl.textContent = 'Error al enviar';
  }
  return;
 }

 if (inserted) {
  renderedMessageIds.delete(tempId);
  renderedMessageIds.add(inserted.id);
  if (optimisticNode) {
   optimisticNode.dataset.msgId = inserted.id;
   optimisticNode.onclick = () => triggerReplyToMessage(inserted.id, inserted.content);
  }
  const prevCache = prefetchedMessagesByConv[targetConvId] || [];
  prefetchedMessagesByConv[targetConvId] = [...prevCache, inserted];
  ogCache.set(`chat_msgs_${targetConvId}`, prefetchedMessagesByConv[targetConvId].slice(-50));
  cachedConversationsList = null;
  ogCache.remove('conversations');
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
