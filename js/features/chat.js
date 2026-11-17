/* Depende de: config.js (db); state.js (currentUser, profilesCache, onlineUsersMap,
   activeConversationId, activeRecipientProfile, replyingToMessageId, replyingToSnippet,
   cachedConversationsList, dmSearchTimer, viewedProfile); utils.js (formatDate,
   createAvatarNode, setAvatarContent); core/navigation.js (showTab)
   En tiempo de ejecución usa funciones de otros módulos: openPublicProfile (profile.js),
   showAuthOverlay (auth.js)
   Expone: checkGlobalUnreadMessages, loadConversations, renderConversationsDOM,
   searchUsersForChat, openDirectChatWithUser, openChatRoom, buildChatMessageNode,
   appendChatMessageNode, scrollToBottomChat, triggerReplyToMessage, cancelReply,
   sendChatMessage, openChatDetailsPage, toggleChatDetailsMenu, handleChatActionMenu,
   openChatRecipientProfile, triggerChatSearch, openMuteOptionsModal, openChatSubSettings */

const OG_CHAT_MSG_FIELDS = 'id, conversation_id, sender_id, content, reply_to_id, reply_to_snippet, created_at';
const OG_CHAT_PROFILE_FIELDS = 'id, username, display_name, avatar_url, bio';

const ogChatRuntime = {
  renderedMsgIds: new Set(),
  messagesCacheByConv: {},
  recipientLastReadAt: null,
  roomChannel: null,
  isSending: false
};

function getChatPrefsKey() {
  return 'og_chat_prefs_' + (currentUser?.id || 'guest');
}

function getAllChatPrefs() {
  try {
    return JSON.parse(localStorage.getItem(getChatPrefsKey()) || '{}');
  } catch (e) {
    return {};
  }
}

function getConvPrefs(convId, recipientId = null) {
  const all = getAllChatPrefs();
  return {
    muted: Boolean(all.muted?.[convId]),
    nickname: all.nicknames?.[recipientId] || '',
    theme: all.themes?.[convId] || 'default',
    blocked: Boolean(all.blocked?.[recipientId]),
    restricted: Boolean(all.restricted?.[recipientId]),
    readReceipts: all.readReceipts !== false,
    timerHours: all.timers?.[convId] || 0
  };
}

function saveConvPref(section, key, value) {
  const all = getAllChatPrefs();
  if (section === 'root') {
    all[key] = value;
  } else {
    if (!all[section]) all[section] = {};
    if (value === null || value === false || value === '') {
      delete all[section][key];
    } else {
      all[section][key] = value;
    }
  }
  localStorage.setItem(getChatPrefsKey(), JSON.stringify(all));
}

function getDisplayNameForChat(profile) {
  if (!profile) return 'Usuario';
  const prefs = getConvPrefs(activeConversationId, profile.id);
  return prefs.nickname || profile.display_name || profile.username || 'Usuario';
}

function showChatFeedbackBanner(container, text, isError = false) {
  if (!container) return;
  let banner = container.querySelector('.og-chat-feedback');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'og-chat-feedback';
    banner.style.cssText = 'padding:10px 14px;border-radius:12px;font-size:12.5px;margin-bottom:10px;text-align:center;';
    container.prepend(banner);
  }
  banner.style.background = isError ? 'rgba(239,68,68,0.12)' : 'var(--bg-subtle)';
  banner.style.color = isError ? '#dc2626' : 'var(--text-primary)';
  banner.style.border = '1px solid var(--border-light)';
  banner.textContent = text;
}

/* ------------------------------------------------------------------------- */
/* 1. Indicador global de mensajes no leídos                                 */
/* ------------------------------------------------------------------------- */
async function checkGlobalUnreadMessages() {
  if (!currentUser) return;
  try {
    const { data: parts, error } = await db
      .from('conversation_participants')
      .select('conversation_id, last_read_at')
      .eq('user_id', currentUser.id);

    if (error || !parts || !parts.length) {
      document.getElementById('navUnreadDot')?.classList.remove('active');
      return;
    }

    const convIds = parts.map(p => p.conversation_id);
    const { data: recentMsgs } = await db
      .from('messages')
      .select('conversation_id, created_at, sender_id')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false })
      .limit(Math.max(convIds.length * 4, 30));

    const latestByConv = {};
    (recentMsgs || []).forEach(m => {
      if (!latestByConv[m.conversation_id]) latestByConv[m.conversation_id] = m;
    });

    let hasUnread = false;
    for (const p of parts) {
      const prefs = getConvPrefs(p.conversation_id);
      if (prefs.muted) continue;
      const latest = latestByConv[p.conversation_id];
      if (latest && latest.sender_id !== currentUser.id) {
        if (!p.last_read_at || new Date(latest.created_at) > new Date(p.last_read_at)) {
          hasUnread = true;
          break;
        }
      }
    }

    const dot = document.getElementById('navUnreadDot');
    if (dot) dot.classList.toggle('active', hasUnread);
  } catch (e) {
    console.error('ÖG Chat - Error verificando no leídos:', e);
  }
}

/* ------------------------------------------------------------------------- */
/* 2. Bandeja de conversaciones                                              */
/* ------------------------------------------------------------------------- */
async function loadConversations() {
  const container = document.getElementById('dmConversationsList');
  if (!container || !currentUser) return;

  if (Array.isArray(cachedConversationsList) && cachedConversationsList.length > 0) {
    renderConversationsDOM(cachedConversationsList, container);
  } else {
    container.innerHTML = '<div class="activity-empty">Cargando conversaciones...</div>';
  }

  try {
    const { data: myParts, error: partsErr } = await db
      .from('conversation_participants')
      .select('conversation_id, last_read_at')
      .eq('user_id', currentUser.id);

    if (partsErr) throw partsErr;

    if (!myParts || !myParts.length) {
      cachedConversationsList = [];
      container.innerHTML = '<div class="activity-empty">No tenés conversaciones todavía. Buscá un usuario arriba para chatear.</div>';
      document.getElementById('navUnreadDot')?.classList.remove('active');
      return;
    }

    const convIds = myParts.map(p => p.conversation_id);

    const [allPartsRes, convsRes, recentMsgsRes] = await Promise.all([
      db.from('conversation_participants')
        .select('conversation_id, user_id')
        .in('conversation_id', convIds),
      db.from('conversations')
        .select('id, updated_at, created_at')
        .in('id', convIds),
      db.from('messages')
        .select('id, conversation_id, content, created_at, sender_id')
        .in('conversation_id', convIds)
        .order('created_at', { ascending: false })
        .limit(Math.max(convIds.length * 8, 60))
    ]);

    const convMap = {};
    myParts.forEach(p => {
      convMap[p.conversation_id] = {
        otherUserId: null,
        last_read_at: p.last_read_at,
        updated_at: null
      };
    });

    (allPartsRes.data || []).forEach(p => {
      if (p.user_id !== currentUser.id && convMap[p.conversation_id]) {
        convMap[p.conversation_id].otherUserId = p.user_id;
      }
    });

    (convsRes.data || []).forEach(c => {
      if (convMap[c.id]) {
        convMap[c.id].updated_at = c.updated_at || c.created_at;
      }
    });

    const latestMsgByConv = {};
    const unreadCountByConv = {};
    (recentMsgsRes.data || []).forEach(m => {
      if (!latestMsgByConv[m.conversation_id]) {
        latestMsgByConv[m.conversation_id] = m;
      }
      const myReadAt = convMap[m.conversation_id]?.last_read_at;
      if (
        m.sender_id !== currentUser.id &&
        (!myReadAt || new Date(m.created_at) > new Date(myReadAt))
      ) {
        unreadCountByConv[m.conversation_id] = (unreadCountByConv[m.conversation_id] || 0) + 1;
      }
    });

    const otherUserIds = [...new Set(Object.values(convMap).map(c => c.otherUserId).filter(Boolean))];
    const missing = otherUserIds.filter(id => !profilesCache[id]);
    if (missing.length > 0) {
      const { data: profs } = await db
        .from('og_profiles')
        .select(OG_CHAT_PROFILE_FIELDS)
        .in('id', missing);
      (profs || []).forEach(p => {
        profilesCache[p.id] = p;
      });
    }

    const list = convIds.map(convId => {
      const entry = convMap[convId];
      const profile = profilesCache[entry?.otherUserId];
      if (!profile) return null;

      const lastMsg = latestMsgByConv[convId] || null;
      const unreadCount = unreadCountByConv[convId] || 0;
      const fallbackDate = entry?.updated_at;
      const sortTs = lastMsg
        ? new Date(lastMsg.created_at).getTime()
        : (fallbackDate ? new Date(fallbackDate).getTime() : 0);

      let snippetText = 'Conversación iniciada';
      if (lastMsg) {
        snippetText = lastMsg.sender_id === currentUser.id
          ? `Tú: ${lastMsg.content}`
          : lastMsg.content;
      }

      return {
        conversationId: convId,
        profile,
        lastMessage: snippetText,
        time: lastMsg ? formatDate(lastMsg.created_at) : (fallbackDate ? formatDate(fallbackDate) : ''),
        timestamp: sortTs,
        isUnread: unreadCount > 0,
        unreadCount
      };
    }).filter(Boolean);

    list.sort((a, b) => b.timestamp - a.timestamp);
    cachedConversationsList = list;
    renderConversationsDOM(list, container);

    const anyUnread = list.some(item => item.isUnread && !getConvPrefs(item.conversationId).muted);
    document.getElementById('navUnreadDot')?.classList.toggle('active', anyUnread);
  } catch (e) {
    console.error('ÖG Chat - Error cargando conversaciones:', e);
    if (!cachedConversationsList || !cachedConversationsList.length) {
      container.innerHTML = '<div class="activity-empty">No se pudieron cargar las conversaciones.</div>';
    }
  }
}

function renderConversationsDOM(conversationsList, container) {
  if (!container) return;
  if (!conversationsList || !conversationsList.length) {
    container.innerHTML = '<div class="activity-empty">No hay conversaciones recientes.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  conversationsList.forEach(item => {
    const prefs = getConvPrefs(item.conversationId, item.profile.id);
    const row = document.createElement('div');
    row.className = 'dm-conv-item' + (item.isUnread ? ' is-unread' : '');
    row.onclick = () => openChatRoom(item.conversationId, item.profile);

    const av = createAvatarNode(item.profile, false);
    av.classList.add('dm-conv-avatar');

    const info = document.createElement('div');
    info.className = 'dm-conv-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'dm-conv-name';

    const nameLabel = document.createElement('span');
    nameLabel.className = 'dm-conv-name-label';
    nameLabel.textContent = prefs.nickname || item.profile.display_name || item.profile.username;

    if (prefs.muted) {
      const muteTag = document.createElement('span');
      muteTag.className = 'dm-mute-tag';
      muteTag.textContent = '🔇';
      nameLabel.append(muteTag);
    }

    const timeSpan = document.createElement('span');
    timeSpan.className = 'dm-conv-time';
    timeSpan.textContent = item.time;

    nameRow.append(nameLabel, timeSpan);

    const bottomRow = document.createElement('div');
    bottomRow.className = 'dm-conv-bottom';

    const snippetDiv = document.createElement('div');
    snippetDiv.className = 'dm-conv-snippet';
    snippetDiv.textContent = item.lastMessage;
    bottomRow.append(snippetDiv);

    if (item.isUnread) {
      const badge = document.createElement('span');
      badge.className = 'dm-unread-badge';
      badge.textContent = item.unreadCount > 9 ? '9+' : String(item.unreadCount);
      bottomRow.append(badge);
    }

    info.append(nameRow, bottomRow);
    row.append(av, info);
    fragment.append(row);
  });

  container.replaceChildren(fragment);
}

/* ------------------------------------------------------------------------- */
/* 3. Búsqueda de usuarios e inicio de chat                                  */
/* ------------------------------------------------------------------------- */
async function searchUsersForChat() {
  clearTimeout(dmSearchTimer);
  const input = document.getElementById('dmSearchInput');
  const resultBox = document.getElementById('dmSearchResults');
  if (!input || !resultBox) return;

  const val = input.value.trim().replace(/^@/, '');
  if (val.length < 1) {
    resultBox.replaceChildren();
    return;
  }

  dmSearchTimer = setTimeout(async () => {
    try {
      const { data, error } = await db
        .from('og_profiles')
        .select(OG_CHAT_PROFILE_FIELDS)
        .or(`username.ilike.%${val}%,display_name.ilike.%${val}%`)
        .limit(12);

      if (error) throw error;

      const filtered = (data || []).filter(p => p.id !== currentUser?.id);
      if (!filtered.length) {
        resultBox.innerHTML = '<p class="muted" style="text-align:center;padding:12px 0;">No se encontraron usuarios.</p>';
        return;
      }

      const fragment = document.createDocumentFragment();
      filtered.forEach(profile => {
        profilesCache[profile.id] = profile;
        const item = document.createElement('div');
        item.className = 'public-user';
        item.append(createAvatarNode(profile, false));

        const info = document.createElement('div');
        info.className = 'public-user-info';
        const strong = document.createElement('strong');
        strong.textContent = profile.display_name || profile.username;
        const small = document.createElement('small');
        small.textContent = '@' + profile.username;
        info.append(strong, small);

        item.append(info);
        item.onclick = () => {
          input.value = '';
          resultBox.replaceChildren();
          openDirectChatWithUser(profile.id);
        };
        fragment.append(item);
      });

      resultBox.replaceChildren(fragment);
    } catch (e) {
      console.error('ÖG Chat - Error buscando usuarios:', e);
      resultBox.innerHTML = '<p class="muted" style="text-align:center;padding:10px 0;">Error al buscar usuarios.</p>';
    }
  }, 220);
}

async function openDirectChatWithUser(recipientId, triggerBtn = null) {
  const targetId = recipientId || viewedProfile?.id;
  if (!currentUser) {
    if (typeof showAuthOverlay === 'function') showAuthOverlay();
    return;
  }
  if (!targetId || targetId === currentUser.id) return;

  const btn = triggerBtn || document.querySelector('#publicprofile .profile-action-buttons-row button.secondary');
  const originalText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Abriendo...';
  }

  try {
    let convId = null;

    // 1. Intentar obtener o crear la conversación mediante RPC
    const { data: rpcConvId, error: rpcError } = await db.rpc('get_or_create_conversation', {
      user_a: currentUser.id,
      user_b: targetId
    });

    if (!rpcError && rpcConvId) {
      convId = rpcConvId;
    } else {
      // 2. Respaldo directo si la RPC no responde o tiene otra firma
      const { data: myParts } = await db
        .from('conversation_participants')
        .select('conversation_id')
        .eq('user_id', currentUser.id);

      const myConvIds = (myParts || []).map(p => p.conversation_id);
      if (myConvIds.length > 0) {
        const { data: shared } = await db
          .from('conversation_participants')
          .select('conversation_id')
          .eq('user_id', targetId)
          .in('conversation_id', myConvIds)
          .limit(1)
          .maybeSingle();

        if (shared?.conversation_id) {
          convId = shared.conversation_id;
        }
      }

      if (!convId) {
        const { data: newConv, error: convErr } = await db
          .from('conversations')
          .insert({})
          .select('id')
          .single();

        if (convErr || !newConv) throw convErr || new Error('No se pudo crear la conversación.');
        convId = newConv.id;

        const { error: partErr } = await db
          .from('conversation_participants')
          .insert([
            { conversation_id: convId, user_id: currentUser.id, last_read_at: new Date().toISOString() },
            { conversation_id: convId, user_id: targetId, last_read_at: null }
          ]);

        if (partErr) throw partErr;
      }
    }

    let profile = profilesCache[targetId] || (viewedProfile?.id === targetId ? viewedProfile : null);
    if (!profile) {
      const { data: fetchedProfile } = await db
        .from('og_profiles')
        .select(OG_CHAT_PROFILE_FIELDS)
        .eq('id', targetId)
        .single();
      profile = fetchedProfile;
    }

    if (!profile) throw new Error('No se encontró el perfil del destinatario.');

    profilesCache[targetId] = profile;
    cachedConversationsList = null;

    await openChatRoom(convId, profile);
  } catch (e) {
    console.error('ÖG Chat - Error abriendo chat directo:', e);
    const statusEl = document.getElementById('publicstatus');
    if (statusEl) {
      statusEl.textContent = 'No se pudo abrir el chat. Intentá de nuevo.';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText || 'Mensaje';
    }
  }
}

/* ------------------------------------------------------------------------- */
/* 4. Sala de chat, historial, confirmación de lectura y Realtime            */
/* ------------------------------------------------------------------------- */
function cleanupChatRoomChannel() {
  if (ogChatRuntime.roomChannel) {
    db.removeChannel(ogChatRuntime.roomChannel);
    ogChatRuntime.roomChannel = null;
  }
}

function setupChatRoomRealtime(conversationId, recipientId) {
  cleanupChatRoomChannel();

  ogChatRuntime.roomChannel = db
    .channel(`chat-room-sync-${conversationId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'conversation_participants',
        filter: `conversation_id=eq.${conversationId}`
      },
      payload => {
        if (payload.new && payload.new.user_id === recipientId) {
          ogChatRuntime.recipientLastReadAt = payload.new.last_read_at;
          refreshSentMessagesReadState();
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`
      },
      payload => {
        const msg = payload.new;
        if (!msg || activeConversationId !== conversationId) return;
        appendChatMessageNode(msg);
        scrollToBottomChat();
      }
    )
    .subscribe();
}

async function markConversationAsRead(conversationId) {
  if (!currentUser || !conversationId) return;
  const prefs = getConvPrefs(conversationId);
  if (!prefs.readReceipts) return;

  const nowIso = new Date().toISOString();
  await db
    .from('conversation_participants')
    .update({ last_read_at: nowIso })
    .eq('conversation_id', conversationId)
    .eq('user_id', currentUser.id);

  cachedConversationsList = null;
  checkGlobalUnreadMessages();
}

function refreshSentMessagesReadState() {
  const container = document.getElementById('chatMessagesContainer');
  if (!container) return;

  const seenTs = ogChatRuntime.recipientLastReadAt
    ? new Date(ogChatRuntime.recipientLastReadAt).getTime()
    : 0;

  container.querySelectorAll('.chat-bubble.sent').forEach(bubble => {
    const receiptEl = bubble.querySelector('.chat-read-receipt');
    if (!receiptEl) return;
    const msgTs = Number(bubble.dataset.createdAtMs || 0);
    if (seenTs > 0 && msgTs > 0 && seenTs >= msgTs) {
      receiptEl.textContent = '✓✓ Visto';
      receiptEl.classList.add('seen');
    } else {
      receiptEl.textContent = '✓ Enviado';
      receiptEl.classList.remove('seen');
    }
  });
}

function renderChatMessagesList(msgs, container) {
  if (!container) return;
  ogChatRuntime.renderedMsgIds.clear();

  if (!msgs || !msgs.length) {
    container.innerHTML = '<div class="activity-empty">Aún no hay mensajes. Escribí el primero.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  let lastDateLabel = '';

  msgs.forEach(m => {
    if (m.id) ogChatRuntime.renderedMsgIds.add(m.id);

    const dateLabel = new Date(m.created_at).toLocaleDateString('es-AR', {
      day: 'numeric',
      month: 'short'
    });
    if (dateLabel !== lastDateLabel) {
      lastDateLabel = dateLabel;
      const divider = document.createElement('div');
      divider.className = 'chat-date-divider';
      divider.textContent = dateLabel;
      fragment.append(divider);
    }

    fragment.append(buildChatMessageNode(m));
  });

  container.replaceChildren(fragment);
  refreshSentMessagesReadState();
  scrollToBottomChat();
}

async function openChatRoom(conversationId, recipientProfile) {
  if (!conversationId || !recipientProfile || !currentUser) return;

  activeConversationId = conversationId;
  activeRecipientProfile = recipientProfile;
  ogChatRuntime.recipientLastReadAt = null;
  cancelReply();

  document.querySelectorAll('main > div').forEach(x => x.classList.remove('active'));
  const roomPage = document.getElementById('chatRoomPage');
  roomPage.classList.remove('theme-blue', 'theme-mono');
  const prefs = getConvPrefs(conversationId, recipientProfile.id);
  if (prefs.theme === 'blue') roomPage.classList.add('theme-blue');
  if (prefs.theme === 'mono') roomPage.classList.add('theme-mono');
  roomPage.classList.add('active');

  const bottomNavBar = document.getElementById('bottomNavBar');
  if (bottomNavBar) bottomNavBar.style.display = 'none';

  document.getElementById('chatRoomTitle').textContent = getDisplayNameForChat(recipientProfile);

  const headerAvatar = document.getElementById('chatRoomHeaderAvatar');
  headerAvatar.replaceChildren();
  if (recipientProfile.avatar_url) {
    const img = document.createElement('img');
    img.src = recipientProfile.avatar_url;
    img.alt = recipientProfile.username;
    headerAvatar.append(img);
  } else {
    headerAvatar.textContent = '👤';
  }

  const dot = document.createElement('span');
  dot.id = 'chatRoomOnlineDot';
  dot.className = 'online-dot';
  if (onlineUsersMap[recipientProfile.id]) dot.classList.add('active');
  headerAvatar.append(dot);

  document.getElementById('chatRoomStatusSub').textContent = onlineUsersMap[recipientProfile.id]
    ? 'En línea'
    : 'Desconectado';

  updateChatBlockedUI(prefs.blocked);
  setupChatRoomRealtime(conversationId, recipientProfile.id);

  const container = document.getElementById('chatMessagesContainer');
  const cachedMsgs = ogChatRuntime.messagesCacheByConv[conversationId];
  if (Array.isArray(cachedMsgs) && cachedMsgs.length > 0) {
    renderChatMessagesList(cachedMsgs, container);
  } else {
    ogChatRuntime.renderedMsgIds.clear();
    container.innerHTML = '<div class="activity-empty">Cargando mensajes...</div>';
  }

  const [participantsRes, msgsRes] = await Promise.all([
    db.from('conversation_participants')
      .select('user_id, last_read_at')
      .eq('conversation_id', conversationId),
    db.from('messages')
      .select(OG_CHAT_MSG_FIELDS)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
  ]);

  if (activeConversationId !== conversationId) return;

  const otherPart = (participantsRes.data || []).find(p => p.user_id === recipientProfile.id);
  ogChatRuntime.recipientLastReadAt = otherPart?.last_read_at || null;

  await markConversationAsRead(conversationId);

  const msgs = msgsRes.data || [];
  ogChatRuntime.messagesCacheByConv[conversationId] = msgs;
  renderChatMessagesList(msgs, container);
}

function updateChatBlockedUI(isBlocked) {
  const footer = document.querySelector('#chatRoomPage .chat-input-footer');
  if (!footer) return;
  const inputRow = footer.querySelector('.chat-input-row');
  let blockedBanner = footer.querySelector('.chat-blocked-banner');

  if (isBlocked) {
    if (inputRow) inputRow.style.display = 'none';
    if (!blockedBanner) {
      blockedBanner = document.createElement('div');
      blockedBanner.className = 'chat-blocked-banner';
      blockedBanner.textContent = 'Bloqueaste esta conversación. Desbloqueala desde Detalles del chat para escribir.';
      footer.append(blockedBanner);
    }
  } else {
    if (inputRow) inputRow.style.display = 'flex';
    if (blockedBanner) blockedBanner.remove();
  }
}

function buildChatMessageNode(msg) {
  const isMine = msg.sender_id === currentUser?.id;
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${isMine ? 'sent' : 'received'}`;
  if (msg.id) bubble.dataset.msgId = msg.id;
  bubble.dataset.createdAtMs = String(new Date(msg.created_at).getTime());
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

  const metaDiv = document.createElement('div');
  metaDiv.className = 'chat-bubble-meta';

  const timeSpan = document.createElement('span');
  timeSpan.textContent = new Date(msg.created_at).toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit'
  });
  metaDiv.append(timeSpan);

  if (isMine) {
    const receiptSpan = document.createElement('span');
    receiptSpan.className = 'chat-read-receipt';
    const seenTs = ogChatRuntime.recipientLastReadAt
      ? new Date(ogChatRuntime.recipientLastReadAt).getTime()
      : 0;
    const msgTs = new Date(msg.created_at).getTime();
    if (seenTs > 0 && seenTs >= msgTs) {
      receiptSpan.textContent = '✓✓ Visto';
      receiptSpan.classList.add('seen');
    } else {
      receiptSpan.textContent = '✓ Enviado';
    }
    metaDiv.append(receiptSpan);
  }

  bubble.append(metaDiv);
  return bubble;
}

function appendChatMessageNode(msg) {
  if (!msg) return null;
  if (msg.id && ogChatRuntime.renderedMsgIds.has(msg.id)) return null;
  if (msg.id) ogChatRuntime.renderedMsgIds.add(msg.id);

  const container = document.getElementById('chatMessagesContainer');
  if (!container) return null;

  const emptyPlaceholder = container.querySelector('.activity-empty');
  if (emptyPlaceholder) emptyPlaceholder.remove();

  const node = buildChatMessageNode(msg);
  container.append(node);

  if (msg.conversation_id) {
    const prev = ogChatRuntime.messagesCacheByConv[msg.conversation_id] || [];
    if (!prev.some(m => m.id === msg.id)) {
      ogChatRuntime.messagesCacheByConv[msg.conversation_id] = [...prev, msg];
    }
  }

  const isRoomVisible = document.getElementById('chatRoomPage')?.classList.contains('active');
  if (isRoomVisible && activeConversationId === msg.conversation_id && msg.sender_id !== currentUser?.id) {
    markConversationAsRead(msg.conversation_id);
  }

  return node;
}

function scrollToBottomChat() {
  const container = document.getElementById('chatMessagesContainer');
  if (container) container.scrollTop = container.scrollHeight;
}

function triggerReplyToMessage(msgId, content) {
  if (!msgId || String(msgId).startsWith('optimistic-')) return;
  replyingToMessageId = msgId;
  replyingToSnippet = content.slice(0, 50) + (content.length > 50 ? '...' : '');
  document.getElementById('replyingTextSnippet').textContent = replyingToSnippet;
  document.getElementById('replyingBar').classList.add('active');
  document.getElementById('chatMessageInput')?.focus();
}

function cancelReply() {
  replyingToMessageId = null;
  replyingToSnippet = null;
  document.getElementById('replyingBar')?.classList.remove('active');
}

async function sendChatMessage() {
  if (!activeConversationId || !currentUser || ogChatRuntime.isSending) return;

  const prefs = getConvPrefs(activeConversationId, activeRecipientProfile?.id);
  if (prefs.blocked) return;

  const input = document.getElementById('chatMessageInput');
  const text = input?.value.trim();
  if (!text) return;

  const targetConvId = activeConversationId;
  const replyId = replyingToMessageId;
  const replySnippet = replyingToSnippet;

  input.value = '';
  cancelReply();
  ogChatRuntime.isSending = true;

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

  try {
    const { data: inserted, error } = await db
      .from('messages')
      .insert({
        conversation_id: targetConvId,
        sender_id: currentUser.id,
        content: text,
        reply_to_id: replyId,
        reply_to_snippet: replySnippet
      })
      .select(OG_CHAT_MSG_FIELDS)
      .single();

    if (error || !inserted) throw error || new Error('Error al insertar mensaje');

    ogChatRuntime.renderedMsgIds.delete(tempId);
    ogChatRuntime.renderedMsgIds.add(inserted.id);

    if (optimisticNode) {
      optimisticNode.dataset.msgId = inserted.id;
      optimisticNode.dataset.createdAtMs = String(new Date(inserted.created_at).getTime());
      optimisticNode.onclick = () => triggerReplyToMessage(inserted.id, inserted.content);
    }

    const list = ogChatRuntime.messagesCacheByConv[targetConvId] || [];
    ogChatRuntime.messagesCacheByConv[targetConvId] = list
      .filter(m => m.id !== tempId && m.id !== inserted.id)
      .concat(inserted);

    cachedConversationsList = null;
  } catch (e) {
    console.error('ÖG Chat - Error enviando mensaje:', e);
    if (optimisticNode) {
      optimisticNode.style.opacity = '0.55';
      const receiptEl = optimisticNode.querySelector('.chat-read-receipt');
      if (receiptEl) receiptEl.textContent = 'Error al enviar';
    }
  } finally {
    ogChatRuntime.isSending = false;
  }
}

/* ------------------------------------------------------------------------- */
/* 5. Detalles, búsqueda en historial y ajustes funcionales del chat         */
/* ------------------------------------------------------------------------- */
function openChatDetailsPage() {
  if (!activeRecipientProfile) return;
  document.querySelectorAll('main > div').forEach(x => x.classList.remove('active'));
  document.getElementById('chatDetailsPage').classList.add('active');

  const av = document.getElementById('chatDetailsAvatarContainer');
  setAvatarContent(av, activeRecipientProfile.avatar_url, '👤');
  document.getElementById('chatDetailsName').textContent = getDisplayNameForChat(activeRecipientProfile);
  document.getElementById('chatDetailsUsername').textContent = '@' + activeRecipientProfile.username;

  const isOnline = Boolean(onlineUsersMap[activeRecipientProfile.id]);
  const statusEl = document.getElementById('chatDetailsActivityStatus');
  statusEl.textContent = isOnline ? 'En línea' : 'Desconectado';
  statusEl.style.color = isOnline ? '#22c55e' : '#888888';
}

function toggleChatDetailsMenu() {
  const dd = document.getElementById('chatDetailsDropdown');
  if (!dd) return;
  dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
}

function handleChatActionMenu(action) {
  const dd = document.getElementById('chatDetailsDropdown');
  if (dd) dd.style.display = 'none';
  if (!activeRecipientProfile) return;

  const container = document.querySelector('#chatDetailsPage .chat-details-content');
  const targetId = activeRecipientProfile.id;
  const prefs = getConvPrefs(activeConversationId, targetId);

  if (action === 'block') {
    const nextBlocked = !prefs.blocked;
    saveConvPref('blocked', targetId, nextBlocked);
    showChatFeedbackBanner(
      container,
      nextBlocked ? 'Usuario bloqueado en tus mensajes.' : 'Usuario desbloqueado.'
    );
  } else if (action === 'restrict') {
    const nextRestricted = !prefs.restricted;
    saveConvPref('restricted', targetId, nextRestricted);
    showChatFeedbackBanner(
      container,
      nextRestricted ? 'Conversación restringida.' : 'Restricción eliminada.'
    );
  } else if (action === 'report') {
    showChatFeedbackBanner(container, 'Reporte registrado para revisión de seguridad.');
  }
}

function openChatRecipientProfile() {
  if (activeRecipientProfile) {
    cleanupChatRoomChannel();
    openPublicProfile(activeRecipientProfile.id);
  }
}

function triggerChatSearch() {
  showTab('chatRoomPage');
  const bottomNavBar = document.getElementById('bottomNavBar');
  if (bottomNavBar) bottomNavBar.style.display = 'none';

  const roomPage = document.getElementById('chatRoomPage');
  let searchBar = roomPage.querySelector('.chat-inroom-search');

  if (!searchBar) {
    searchBar = document.createElement('div');
    searchBar.className = 'chat-inroom-search';
    searchBar.innerHTML = `
      <input type="text" placeholder="Buscar en esta conversación..." aria-label="Buscar en el chat">
      <button class="secondary" style="padding:5px 10px;font-size:12px;">Cerrar</button>
    `;
    const header = roomPage.querySelector('.chat-room-header');
    header.insertAdjacentElement('afterend', searchBar);

    const input = searchBar.querySelector('input');
    const closeBtn = searchBar.querySelector('button');

    input.addEventListener('input', () => {
      const term = input.value.trim().toLowerCase();
      const bubbles = document.querySelectorAll('#chatMessagesContainer .chat-bubble');
      let firstMatch = null;
      bubbles.forEach(b => {
        b.classList.remove('search-match');
        if (term && b.textContent.toLowerCase().includes(term)) {
          b.classList.add('search-match');
          if (!firstMatch) firstMatch = b;
        }
      });
      if (firstMatch) firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    closeBtn.addEventListener('click', () => {
      input.value = '';
      document.querySelectorAll('#chatMessagesContainer .chat-bubble').forEach(b => b.classList.remove('search-match'));
      searchBar.classList.remove('active');
    });
  }

  searchBar.classList.add('active');
  searchBar.querySelector('input')?.focus();
}

function openMuteOptionsModal() {
  if (!activeConversationId) return;
  const prefs = getConvPrefs(activeConversationId);
  const nextMuted = !prefs.muted;
  saveConvPref('muted', activeConversationId, nextMuted);
  cachedConversationsList = null;

  const container = document.querySelector('#chatDetailsPage .chat-details-content');
  showChatFeedbackBanner(
    container,
    nextMuted ? 'Notificaciones de este chat silenciadas.' : 'Notificaciones reactivadas.'
  );
}

function openChatSubSettings(type) {
  document.querySelectorAll('main > div').forEach(x => x.classList.remove('active'));
  document.getElementById('chatSubSettingsPage').classList.add('active');

  const titleEl = document.getElementById('chatSubSettingsTitle');
  const bodyEl = document.getElementById('chatSubSettingsBody');
  bodyEl.replaceChildren();

  const prefs = getConvPrefs(activeConversationId, activeRecipientProfile?.id);

  if (type === 'privacy') {
    titleEl.textContent = 'Privacidad y seguridad';
    bodyEl.innerHTML = `
      <div class="settings-row">
        <div class="settings-row-info">
          <p class="settings-row-title">Confirmaciones de lectura</p>
          <p class="settings-row-desc">Mostrar cuando leés los mensajes de esta cuenta.</p>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="chatReadReceiptsToggle" ${prefs.readReceipts ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <button class="secondary" id="chatToggleBlockBtn">${prefs.blocked ? 'Desbloquear usuario' : 'Bloquear usuario'}</button>
    `;

    document.getElementById('chatReadReceiptsToggle')?.addEventListener('change', e => {
      saveConvPref('root', 'readReceipts', e.target.checked);
      showChatFeedbackBanner(bodyEl, 'Preferencia de lectura actualizada.');
    });

    document.getElementById('chatToggleBlockBtn')?.addEventListener('click', () => {
      if (!activeRecipientProfile) return;
      const updated = !getConvPrefs(activeConversationId, activeRecipientProfile.id).blocked;
      saveConvPref('blocked', activeRecipientProfile.id, updated);
      document.getElementById('chatToggleBlockBtn').textContent = updated ? 'Desbloquear usuario' : 'Bloquear usuario';
      showChatFeedbackBanner(bodyEl, updated ? 'Usuario bloqueado.' : 'Usuario desbloqueado.');
    });
  } else if (type === 'timer') {
    titleEl.textContent = 'Mensajes temporales';
    bodyEl.innerHTML = `
      <p class="muted">Elegí la duración de referencia para esta conversación:</p>
      <button class="secondary" data-hours="0">Desactivado ${prefs.timerHours === 0 ? '✓' : ''}</button>
      <button class="secondary" data-hours="24">24 horas ${prefs.timerHours === 24 ? '✓' : ''}</button>
      <button class="secondary" data-hours="168">7 días ${prefs.timerHours === 168 ? '✓' : ''}</button>
    `;
    bodyEl.querySelectorAll('button[data-hours]').forEach(btn => {
      btn.addEventListener('click', () => {
        const hrs = Number(btn.dataset.hours);
        saveConvPref('timers', activeConversationId, hrs);
        openChatSubSettings('timer');
      });
    });
  } else if (type === 'nickname') {
    titleEl.textContent = 'Apodos';
    bodyEl.innerHTML = `
      <p class="muted">Este apodo se mostrará en tu lista de chats y en la cabecera.</p>
      <input class="field" id="nicknameInput" placeholder="Apodo personalizado" value="${prefs.nickname.replace(/"/g, '&quot;')}">
      <button class="primary" id="saveNicknameBtn">Guardar apodo</button>
    `;
    document.getElementById('saveNicknameBtn')?.addEventListener('click', () => {
      if (!activeRecipientProfile) return;
      const val = document.getElementById('nicknameInput').value.trim();
      saveConvPref('nicknames', activeRecipientProfile.id, val);
      cachedConversationsList = null;
      showChatFeedbackBanner(bodyEl, val ? `Apodo guardado: ${val}` : 'Apodo restablecido.');
    });
  } else if (type === 'style') {
    titleEl.textContent = 'Personalizar estilo';
    bodyEl.innerHTML = `
      <p class="muted">Seleccioná el estilo de burbujas para este chat:</p>
      <button class="secondary" data-theme="default">Minimalista Blanco ${prefs.theme === 'default' ? '✓' : ''}</button>
      <button class="secondary" data-theme="blue">Azul ÖG ${prefs.theme === 'blue' ? '✓' : ''}</button>
      <button class="secondary" data-theme="mono">Monocromo ${prefs.theme === 'mono' ? '✓' : ''}</button>
    `;
    bodyEl.querySelectorAll('button[data-theme]').forEach(btn => {
      btn.addEventListener('click', () => {
        saveConvPref('themes', activeConversationId, btn.dataset.theme);
        openChatSubSettings('style');
      });
    });
  }
}
