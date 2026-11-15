/* Depende de: config.js (db); state.js (currentUser, presenceChannel, onlineUsersMap,
   activeRecipientProfile, realtimeChannel, dmRealtimeChannel, postsRealtimeChannel,
   cachedActivityEvents, cachedConversationsList, cachedFeedPosts, highlightsCacheByUser,
   viewedProfile, activeConversationId, loadedPostIds, profilesCache)
   En tiempo de ejecución usa funciones de features/: loadActivity, loadStoriesData,
   loadHighlights, loadConversations, appendChatMessageNode, scrollToBottomChat,
   prependSinglePostToFeed
   Expone: setupPresenceChannel, setupRealtimeNotifications */
function setupPresenceChannel() {
 if (presenceChannel) db.removeChannel(presenceChannel);

 try {
  const raw = localStorage.getItem('og_user_settings_' + (currentUser?.id || 'guest'));
  const prefs = raw ? JSON.parse(raw) : {};
  if (prefs.activityStatus === false) return;
 } catch (e) {}

 presenceChannel = db.channel('online-users-room', {
  config: { presence: { key: currentUser.id } }
 });

 presenceChannel
  .on('presence', { event: 'sync' }, () => {
   const state = presenceChannel.presenceState();
   onlineUsersMap = {};
   Object.keys(state).forEach(userId => { onlineUsersMap[userId] = true; });

   document.querySelectorAll('.online-dot').forEach(dot => dot.classList.remove('active'));
   Object.keys(onlineUsersMap).forEach(userId => {
    const d = document.getElementById(`online-dot-${userId}`);
    if (d) d.classList.add('active');
   });

   if (activeRecipientProfile && onlineUsersMap[activeRecipientProfile.id]) {
    document.getElementById('chatRoomOnlineDot').classList.add('active');
    document.getElementById('chatRoomStatusSub').textContent = 'En línea';
    const detStatus = document.getElementById('chatDetailsActivityStatus');
    if (detStatus) { detStatus.textContent = 'En línea'; detStatus.style.color = '#22c55e'; }
   } else if (activeRecipientProfile) {
    document.getElementById('chatRoomOnlineDot').classList.remove('active');
    document.getElementById('chatRoomStatusSub').textContent = 'Desconectado';
    const detStatus = document.getElementById('chatDetailsActivityStatus');
    if (detStatus) { detStatus.textContent = 'Desconectado'; detStatus.style.color = '#888888'; }
   }
  })
  .subscribe(async status => {
   if (status === 'SUBSCRIBED') {
    await presenceChannel.track({ online_at: new Date().toISOString() });
   }
  });
}

function setupRealtimeNotifications() {
 if (realtimeChannel) db.removeChannel(realtimeChannel);
 if (dmRealtimeChannel) db.removeChannel(dmRealtimeChannel);
 if (postsRealtimeChannel) db.removeChannel(postsRealtimeChannel);

 realtimeChannel = db.channel('public-notifications')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'follows' }, payload => {
   if (payload.new.following_id === currentUser?.id) { cachedActivityEvents = null; loadActivity(); loadStoriesData(); }
  })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'likes' }, () => { cachedActivityEvents = null; loadActivity(); })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments' }, () => { cachedActivityEvents = null; loadActivity(); })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'stories' }, () => { loadStoriesData(); })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'story_likes' }, () => { cachedActivityEvents = null; loadActivity(); })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'highlights' }, payload => {
   const targetUid = payload.new?.user_id || payload.old?.user_id;
   if (targetUid) {
    delete highlightsCacheByUser[targetUid];
    if (currentUser && targetUid === currentUser.id) {
     loadHighlights(currentUser.id, 'highlightsScrollContainer');
    } else if (viewedProfile && targetUid === viewedProfile.id) {
     loadHighlights(viewedProfile.id, 'publicHighlightsScrollContainer');
    }
   }
  })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'highlight_items' }, payload => {
   const targetUid = payload.new?.user_id || payload.old?.user_id;
   if (targetUid) {
    delete highlightsCacheByUser[targetUid];
    if (currentUser && targetUid === currentUser.id) {
     loadHighlights(currentUser.id, 'highlightsScrollContainer');
    } else if (viewedProfile && targetUid === viewedProfile.id) {
     loadHighlights(viewedProfile.id, 'publicHighlightsScrollContainer');
    }
   }
  })
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts' }, payload => {
   const updated = payload.new;
   document.querySelectorAll(`[data-post-views="${updated.id}"]`).forEach(b => { b.textContent = updated.views || 0; });
  })
  .subscribe();

 dmRealtimeChannel = db.channel('global-dm-listener')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
   const newMsg = payload.new;
   if (newMsg.sender_id !== currentUser?.id) {
    document.getElementById('navUnreadDot').classList.add('active');
    cachedConversationsList = null;
    if (document.getElementById('messagesPage').classList.contains('active')) loadConversations();
    if (activeConversationId === newMsg.conversation_id) {
     appendChatMessageNode(newMsg);
     scrollToBottomChat();
    }
   }
  })
  .subscribe();

 postsRealtimeChannel = db.channel('global-posts-feed')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, async payload => {
   const newPost = payload.new;
   if (!newPost || loadedPostIds.has(newPost.id)) return;

   const { data: followCheck } = await db.from('follows')
    .select('*')
    .eq('follower_id', currentUser.id)
    .eq('following_id', newPost.user_id)
    .maybeSingle();

   if (newPost.user_id !== currentUser.id && !followCheck) return;

   if (!profilesCache[newPost.user_id]) {
    const { data: prof } = await db.from('profiles').select('id, username, display_name, avatar_url').eq('id', newPost.user_id).maybeSingle();
    if (prof) profilesCache[prof.id] = prof;
   }

   if (cachedFeedPosts) cachedFeedPosts.unshift(newPost);
   prependSinglePostToFeed(newPost);
  })
  .subscribe();
}

