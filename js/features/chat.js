
/* ==========================================
   ÖG CHAT - SISTEMA DE MENSAJES
   Depende de config.js, state.js y utils.js
   ========================================== */

async function checkGlobalUnreadMessages() {
 if (!currentUser) return;

 const { data: parts, error } = await db
  .from('conversation_participants')
  .select('conversation_id, last_read_at')
  .eq('user_id', currentUser.id);

 if (error || !parts || !parts.length) {
  const dot = document.getElementById('navUnreadDot');
  if (dot) dot.classList.remove('active');
  return;
 }

 for (const p of parts) {
  const { data: latest } = await db
   .from('messages')
   .select('created_at, sender_id')
   .eq('conversation_id', p.conversation_id)
   .order('created_at', { ascending: false })
   .limit(1)
   .maybeSingle();

  if (latest && latest.sender_id !== currentUser.id) {
   if (!p.last_read_at ||
       new Date(latest.created_at) > new Date(p.last_read_at)) {
    const dot = document.getElementById('navUnreadDot');
    if (dot) dot.classList.add('active');
    return;
   }
  }
 }

 const dot = document.getElementById('navUnreadDot');
 if (dot) dot.classList.remove('active');
}

async function loadConversations() {
 const container = document.getElementById('dmConversationsList');
 if (!currentUser || !container) return;

 try {
  const { data: myParts, error } = await db
   .from('conversation_participants')
   .select('conversation_id, last_read_at')
   .eq('user_id', currentUser.id);

  if (error) throw error;

  if (!myParts || !myParts.length) {
   container.innerHTML =
    '<div class="activity-empty">No tenés conversaciones activas.</div>';
   return;
  }

  const convIds = myParts.map(p => p.conversation_id);

  const { data: allParts, error: partsError } = await db
   .from('conversation_participants')
   .select('conversation_id, user_id')
   .in('conversation_id', convIds);

  if (partsError) throw partsError;

  const convMap = {};

  convIds.forEach(id => {
   const mine = myParts.find(p => p.conversation_id === id);
   convMap[id] = {
    otherUserId: null,
    last_read_at: mine?.last_read_at
   };
  });

  (allParts || []).forEach(p => {
   if (p.user_id !== currentUser.id && convMap[p.conversation_id]) {
    convMap[p.conversation_id].otherUserId = p.user_id;
   }
  });

  const otherUserIds = [
   ...new Set(
    Object.values(convMap)
     .map(c => c.otherUserId)
     .filter(Boolean)
   )
  ];

  const missing = otherUserIds.filter(id => !profilesCache[id]);

  if (missing.length) {
   const { data: profs, error: profileError } = await db
    .from('og_profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', missing);

   if (profileError) throw profileError;

   (profs || []).forEach(p => {
    profilesCache[p.id] = p;
   });
  }

  const conversationsList = await Promise.all(
   convIds.map(async convId => {
    const otherId = convMap[convId].otherUserId;
    if (!otherId) return null;

    const profile = profilesCache[otherId];
    if (!profile) return null;

    const { data: lastMsg } = await db
     .from('messages')
     .select('content, created_at, sender_id')
     .eq('conversation_id', convId)
     .order('created_at', { ascending: false })
     .limit(1)
     .maybeSingle();

    const isUnread = lastMsg &&
     lastMsg.sender_id !== currentUser.id &&
     (!convMap[convId].last_read_at ||
      new Date(lastMsg.created_at) >
      new Date(convMap[convId].last_read_at));

    return {
     conversationId: convId,
     profile,
     lastMessage: lastMsg
      ? lastMsg.content
      : 'Conversación iniciada',
     time: lastMsg ? formatDate(lastMsg.created_at) : '',
     timestamp: lastMsg
      ? new Date(lastMsg.created_at).getTime()
      : 0,
     isUnread
    };
   })
  );

  const valid = conversationsList.filter(Boolean);
  valid.sort((a, b) => b.timestamp - a.timestamp);

  renderConversationsDOM(valid, container);

 } catch (e) {
  console.error('Ög: error cargando conversaciones:', e);
  container.innerHTML =
   '<div class="activity-empty">Error al cargar conversaciones.</div>';
 }
}

function renderConversationsDOM(conversationsList, container) {
 if (!conversationsList.length) {
  container.innerHTML =
   '<div class="activity-empty">No hay conversaciones recientes.</div>';
  return;
 }

 const fragment = document.createDocumentFragment();

 conversationsList.forEach(item => {
  const row = document.createElement('div');
  row.className = 'dm-conv-item';

  row.onclick = () =>
   openChatRoom(item.conversationId, item.profile);

  const av = createAvatarNode(item.profile, false);
  av.className += ' dm-conv-avatar';

  const info = document.createElement('div');
  info.className = 'dm-conv-info';

  const name = document.createElement('div');
  name.className = 'dm-conv-name';

  const username = document.createElement('span');
  username.textContent =
   item.profile.display_name || item.profile.username;

  const time = document.createElement('span');
  time.className = 'dm-conv-time';
  time.textContent = item.time;

  name.append(username, time);

  const snippet = document.createElement('div');
  snippet.className = 'dm-conv-snippet';
  snippet.textContent = item.lastMessage;

  info.append(name, snippet);

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

 const input = document.getElementById('dmSearchInput');
 const resultBox = document.getElementById('dmSearchResults');

 if (!input || !resultBox) return;

 const val = input.value.trim();

 if (val.length < 2) {
  resultBox.replaceChildren();
  return;
 }

 dmSearchTimer = setTimeout(async () => {
  try {
   const { data, error } = await db
    .from('og_profiles')
    .select('id, username, display_name, avatar_url')
    .ilike('username', '%' + val + '%')
    .limit(10);

   if (error) throw error;

   if (!data || !data.length) {
    resultBox.innerHTML =
     '<p class="muted" style="text-align:center;padding:10px">No se encontraron usuarios.</p>';
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

    const strong = document.createElement('strong');
    strong.textContent =
     profile.display_name || profile.username;

    const small = document.createElement('small');
    small.textContent = '@' + profile.username;

    info.append(strong, small);
    item.append(info);

    item.onclick = () =>
     openDirectChatWithUser(profile.id);

    fragment.append(item);
   });

   resultBox.replaceChildren(fragment);

  } catch (error) {
   console.error('Ög: error buscando usuarios:', error);
  }
 }, 200);
}

function showChatNotice(message, type = 'error') {
 const container = document.getElementById('chatMessagesContainer');

 if (!container) {
  alert(message);
  return;
 }

 let notice = document.getElementById('chatSendStatus');

 if (!notice) {
  notice = document.createElement('div');
  notice.id = 'chatSendStatus';
  notice.setAttribute('role', 'status');

  notice.style.cssText =
   'margin:10px 14px;padding:10px 12px;border-radius:12px;font-size:12px;line-height:1.4;';

  container.prepend(notice);
 }

 notice.textContent = message;

 notice.style.background =
  type === 'success'
   ? 'rgba(34,197,94,.10)'
   : 'rgba(220,38,38,.10)';

 notice.style.color =
  type === 'success' ? '#15803d' : '#b91c1c';
}

async function openDirectChatWithUser(recipientId) {
 if (!currentUser || !recipientId) {
  alert('No se pudo abrir el chat: falta tu sesión o el usuario destinatario.');
  return;
 }

 if (recipientId === currentUser.id) return;

 try {
  let profile = profilesCache[recipientId];

  if (!profile) {
   const profileResult = await db
    .from('og_profiles')
    .select('id, username, display_name, avatar_url')
    .eq('id', recipientId)
    .single();

   if (profileResult.error) throw profileResult.error;

   profile = profileResult.data;
  }

  if (!profile) {
   throw new Error('No se encontró el perfil destinatario.');
  }

  profilesCache[recipientId] = profile;

  const result = await db.rpc(
   'get_or_create_conversation',
   {
    user_a: currentUser.id,
    user_b: recipientId
   }
  );

  if (result.error) throw result.error;

  let conversationId = result.data;

  if (Array.isArray(conversationId)) {
   conversationId = conversationId[0];
  }

  if (conversationId && typeof conversationId === 'object') {
   conversationId =
    conversationId.conversation_id || conversationId.id;
  }

  if (typeof conversationId !== 'string' || !conversationId) {
   throw new Error(
    'Supabase no devolvió un identificador válido de conversación.'
   );
  }

  await openChatRoom(conversationId, profile);

 } catch (error) {
  console.error('Ög chat: error al abrir conversación:', error);

  alert(
   'No se pudo abrir la conversación: ' +
   (error.message || 'Error desconocido')
  );
 }
}

async function openChatRoom(conversationId, recipientProfile) {
 if (!currentUser || !conversationId || !recipientProfile) {
  console.error('Ög: faltan datos para abrir el chat.');
  return;
 }

 activeConversationId = conversationId;
 activeRecipientProfile = recipientProfile;

 cancelReply();

 document.querySelectorAll('main>div')
  .forEach(x => x.classList.remove('active'));

 const page = document.getElementById('chatRoomPage');

 if (!page) {
  console.error('Ög: no existe #chatRoomPage');
  return;
 }

 page.classList.add('active');

 const bottomNavBar =
  document.getElementById('bottomNavBar');

 if (bottomNavBar) {
  bottomNavBar.style.display = 'none';
 }

 const title = document.getElementById('chatRoomTitle');

 if (title) {
  title.textContent =
   recipientProfile.display_name ||
   recipientProfile.username;
 }

 const headerAvatar =
  document.getElementById('chatRoomHeaderAvatar');

 if (headerAvatar) {
  headerAvatar.replaceChildren();

  if (recipientProfile.avatar_url) {
   const img = document.createElement('img');
   img.src = recipientProfile.avatar_url;
   img.alt = '';
   headerAvatar.append(img);
  } else {
   headerAvatar.textContent = '👤';
  }

  const dot = document.createElement('span');
  dot.id = 'chatRoomOnlineDot';
  dot.className = 'online-dot';

  if (onlineUsersMap[recipientProfile.id]) {
   dot.classList.add('active');
  }

  headerAvatar.append(dot);
 }

 const status = document.getElementById('chatRoomStatusSub');

 if (status) {
  status.textContent =
   onlineUsersMap[recipientProfile.id]
    ? 'En línea'
    : 'Desconectado';
 }

 const container =
  document.getElementById('chatMessagesContainer');

 if (!container) return;

 container.innerHTML =
  '<div class="activity-empty">Cargando mensajes...</div>';

 try {
  const readResult = await db
   .from('conversation_participants')
   .update({
    last_read_at: new Date().toISOString()
   })
   .eq('conversation_id', conversationId)
   .eq('user_id', currentUser.id);

  if (readResult.error) {
   console.warn('Ög: no se pudo actualizar lectura:', readResult.error);
  }

  const { data: msgs, error } = await db
   .from('messages')
   .select('*')
   .eq('conversation_id', conversationId)
   .order('created_at', { ascending: true });

  if (error) throw error;

  container.replaceChildren();

  if (msgs && msgs.length) {
   const fragment = document.createDocumentFragment();

   msgs.forEach(m => {
    fragment.append(buildChatMessageNode(m));
   });

   container.append(fragment);
  }

  scrollToBottomChat();

  checkGlobalUnreadMessages();

 } catch (error) {
  console.error('Ög: error cargando mensajes:', error);

  container.replaceChildren();

  showChatNotice(
   'No se pudieron cargar los mensajes: ' +
   (error.message || 'Error desconocido')
  );
 }
}

function buildChatMessageNode(msg) {
 const isMine = msg.sender_id === currentUser.id;

 const bubble = document.createElement('div');
 bubble.className =
  `chat-bubble ${isMine ? 'sent' : 'received'}`;

 bubble.onclick = () =>
  triggerReplyToMessage(msg.id, msg.content);

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

 timeDiv.textContent = new Date(
  msg.created_at
 ).toLocaleTimeString('es-AR', {
  hour: '2-digit',
  minute: '2-digit'
 });

 bubble.append(timeDiv);

 return bubble;
}

function appendChatMessageNode(msg) {
 const container =
  document.getElementById('chatMessagesContainer');

 if (!container) return;

 container.append(buildChatMessageNode(msg));
}

function scrollToBottomChat() {
 const container =
  document.getElementById('chatMessagesContainer');

 if (container) {
  container.scrollTop = container.scrollHeight;
 }
}

function triggerReplyToMessage(msgId, content) {
 replyingToMessageId = msgId;

 replyingToSnippet =
  content.slice(0, 45) +
  (content.length > 45 ? '...' : '');

 const snippet =
  document.getElementById('replyingTextSnippet');

 const bar =
  document.getElementById('replyingBar');

 const input =
  document.getElementById('chatMessageInput');

 if (snippet) snippet.textContent = replyingToSnippet;
 if (bar) bar.classList.add('active');
 if (input) input.focus();
}

function cancelReply() {
 replyingToMessageId = null;
 replyingToSnippet = null;

 const bar = document.getElementById('replyingBar');

 if (bar) {
  bar.classList.remove('active');
 }
}

/* ==========================================
   ENVÍO DE MENSAJES
   ========================================== */

async function sendChatMessage(event) {
 if (event) {
  event.preventDefault();
  event.stopPropagation();
 }

 if (!currentUser) {
  showChatNotice('Tu sesión no está activa. Volvé a iniciar sesión.');
  return;
 }

 if (!activeConversationId) {
  showChatNotice('No hay una conversación activa. Volvé al perfil y tocá Mensaje.');
  return;
 }

 const input =
  document.getElementById('chatMessageInput');

 if (!input) {
  console.error('Ög: no se encontró #chatMessageInput');
  return;
 }

 const content = input.value.trim();

 if (!content) return;

 const sendButton =
  document.getElementById('chatSendButton') ||
  input.parentElement?.querySelector('button');

 if (sendButton) sendButton.disabled = true;

 try {
  // Verificar participación.
  const participantResult = await db
   .from('conversation_participants')
   .select('conversation_id')
   .eq('conversation_id', activeConversationId)
   .eq('user_id', currentUser.id)
   .maybeSingle();

  if (participantResult.error) {
   throw participantResult.error;
  }

  if (!participantResult.data) {
   throw new Error(
    'Tu cuenta no figura como participante de esta conversación.'
   );
  }

  // Guardar mensaje.
  const insertResult = await db
   .from('messages')
   .insert({
    conversation_id: activeConversationId,
    sender_id: currentUser.id,
    content: content
   })
   .select('id, conversation_id, sender_id, content, created_at')
   .single();

  if (insertResult.error) {
   throw insertResult.error;
  }

  if (!insertResult.data) {
   throw new Error('Supabase no confirmó el guardado del mensaje.');
  }

  // Limpiar campo solamente cuando se guardó correctamente.
  input.value = '';

  cancelReply();

  const oldNotice =
   document.getElementById('chatSendStatus');

  if (oldNotice) oldNotice.remove();

  appendChatMessageNode(insertResult.data);
  scrollToBottomChat();

  cachedConversationsList = null;

  // Actualizar lectura sin bloquear el envío.
  db.from('conversation_participants')
   .update({
    last_read_at: new Date().toISOString()
   })
   .eq('conversation_id', activeConversationId)
   .eq('user_id', currentUser.id)
   .then(({ error }) => {
    if (error) {
     console.warn(
      'Ög: no se pudo actualizar last_read_at:',
      error
     );
    }
   });

  console.log(
   'Ög: mensaje guardado correctamente',
   insertResult.data
  );

 } catch (error) {
  console.error('Ög: error al enviar mensaje:', error);

  showChatNotice(
   'No se pudo enviar el mensaje: ' +
   (error.message || 'Error desconocido')
  );

 } finally {
  if (sendButton) sendButton.disabled = false;
 }
}

/* ==========================================
   DETALLES Y CONFIGURACIÓN DEL CHAT
   ========================================== */

function openChatDetailsPage() {
 if (!activeRecipientProfile) return;

 document.querySelectorAll('main>div')
  .forEach(x => x.classList.remove('active'));

 document.getElementById('chatDetailsPage')
  .classList.add('active');

 const av =
  document.getElementById('chatDetailsAvatarContainer');

 setAvatarContent(
  av,
  activeRecipientProfile.avatar_url,
  '👤'
 );

 document.getElementById('chatDetailsName').textContent =
  activeRecipientProfile.display_name ||
  activeRecipientProfile.username;

 document.getElementById('chatDetailsUsername').textContent =
  '@' + activeRecipientProfile.username;

 const isOnline =
  onlineUsersMap[activeRecipientProfile.id];

 const statusEl =
  document.getElementById('chatDetailsActivityStatus');

 statusEl.textContent =
  isOnline ? 'En línea' : 'Desconectado';

 statusEl.style.color =
  isOnline ? '#22c55e' : '#888888';
}

function toggleChatDetailsMenu() {
 const dd =
  document.getElementById('chatDetailsDropdown');

 if (!dd) return;

 dd.style.display =
  dd.style.display === 'block' ? 'none' : 'block';
}

function handleChatActionMenu(action) {
 const dropdown =
  document.getElementById('chatDetailsDropdown');

 if (dropdown) dropdown.style.display = 'none';

 if (action === 'block') alert('Usuario bloqueado.');
 if (action === 'report') alert('Reporte enviado.');
 if (action === 'restrict') alert('Cuenta restringida.');
}

function openChatRecipientProfile() {
 if (activeRecipientProfile) {
  openPublicProfile(activeRecipientProfile.id);
 }
}

function triggerChatSearch() {
 const query = prompt('Buscar mensaje en el chat:');

 if (!query) return;

 alert(`Buscando "${query}" en el historial...`);
}

function openMuteOptionsModal() {
 alert('Notificaciones del chat silenciadas.');
}

function openChatSubSettings(type) {
 document.querySelectorAll('main>div')
  .forEach(x => x.classList.remove('active'));

 document.getElementById('chatSubSettingsPage')
  .classList.add('active');

 const titleEl =
  document.getElementById('chatSubSettingsTitle');

 const bodyEl =
  document.getElementById('chatSubSettingsBody');

 bodyEl.replaceChildren();

 if (type === 'privacy') {
  titleEl.textContent = 'Privacidad y seguridad';

  bodyEl.innerHTML = `
   <div class="settings-row">
    <div class="settings-row-info">
     <p class="settings-row-title">
      Confirmaciones de lectura
     </p>
     <p class="settings-row-desc">
      Mostrar cuando leés los mensajes.
     </p>
    </div>
    <label class="toggle-switch">
     <input type="checkbox" checked>
     <span class="toggle-slider"></span>
    </label>
   </div>
  `;

 } else if (type === 'timer') {
  titleEl.textContent = 'Mensajes temporales';

  bodyEl.innerHTML = `
   <p class="muted">
    Los mensajes enviados desaparecerán automáticamente
    después del tiempo seleccionado.
   </p>
   <button class="secondary"
    onclick="alert('Temporizador desactivado')">
    Desactivado
   </button>
   <button class="secondary"
    onclick="alert('Configurado a 24 horas')">
    24 horas
   </button>
   <button class="secondary"
    onclick="alert('Configurado a 7 días')">
    7 días
   </button>
  `;

 } else if (type === 'nickname') {
  titleEl.textContent = 'Apodos';

  bodyEl.innerHTML = `
   <input class="field"
    id="nicknameInput"
    placeholder="Nuevo apodo">
   <button class="primary"
    onclick="alert('Apodo actualizado')">
    Guardar apodo
   </button>
  `;

 } else if (type === 'style') {
  titleEl.textContent = 'Personalizar estilo';

  bodyEl.innerHTML = `
   <p class="muted">
    Tema actual: Minimalista Blanco
   </p>
   <button class="secondary"
    onclick="alert('Tema azul clásico aplicado')">
    Azul Clásico
   </button>
   <button class="secondary"
    onclick="alert('Tema monocromo aplicado')">
    Monocromo
   </button>
  `;
 }
}
