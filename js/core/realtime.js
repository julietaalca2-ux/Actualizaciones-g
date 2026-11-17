/* Depende de: config.js (db); state.js (currentUser, presenceChannel, onlineUsersMap,
   activeRecipientProfile, realtimeChannel, dmRealtimeChannel, postsRealtimeChannel,
   cachedActivityEvents, cachedConversationsList, cachedFeedPosts, cachedFollowingIds,
   highlightsCacheByUser, viewedProfile, activeConversationId, loadedPostIds,
   profilesCache, renderedMessageIds, prefetchedConversationIds);
   utils.js (ogCache, setCachedProfile, PROFILE_MINI_FIELDS, POST_SELECT_FIELDS)
   En tiempo de ejecución usa funciones de features/: loadActivity, loadStoriesData,
   loadHighlights, loadConversations, appendChatMessageNode, scrollToBottomChat,
   prependSinglePostToFeed
   Expone: setupPresenceChannel, setupRealtimeNotifications */

function invalidateActivityCacheAndRefreshIfVisible() {
 cachedActivityEvents = null;
 ogCache.remove('activity_events');
 if (document.getElementById('notifications')?.classList.contains('active')) {
  loadActivity();
 }
}

function setupPresenceChannel() {
 if (presenceChannel) {
  db.removeChannel(presenceChannel);
  presenceChannel = null;
 }
 if (!currentUser) return;

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
    document.getElementById('chatRoomOnlineDot')?.classList.add('active');
    const sub = document.getElementById('chatRoomStatusSub');
    if (sub) sub.textContent = 'En línea';
    const detStatus = document.getElementById('chatDetailsActivityStatus');
    if (detStatus) { detStatus.textContent = 'En línea'; detStatus.style.color = '#22c55e'; }
   } else if (activeRecipientProfile) {
    document.getElementById('chatRoomOnlineDot')?.classList.remove('active');
    const sub = document.getElementById('chatRoomStatusSub');
    if (sub) sub.textContent = 'Desconectado';
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
 if (realtimeChannel) { db.removeChannel(realtimeChannel); realtimeChannel = null; }
 if (dmRealtimeChannel) { db.removeChannel(dmRealtimeChannel); dmRealtimeChannel = null; }
 if (postsRealtimeChannel) { db.removeChannel(postsRealtimeChannel); postsRealtimeChannel = null; }
 // Llamadas: escucha las llamadas entrantes (o se desconecta si no hay sesión)
 if (typeof initCallSignaling === 'function') initCallSignaling();
 if (!currentUser) return;

 realtimeChannel = db.channel('public-notifications')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'follows' }, payload => {
   if (payload.new.following_id === currentUser?.id) {
    invalidateActivityCacheAndRefreshIfVisible();
    loadStoriesData();
   }
  })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'likes' }, payload => {
   if (payload.new?.user_id !== currentUser?.id) {
    invalidateActivityCacheAndRefreshIfVisible();
   }
  })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments' }, payload => {
   if (payload.new?.user_id !== currentUser?.id) {
    invalidateActivityCacheAndRefreshIfVisible();
   }
  })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'stories' }, () => {
   loadStoriesData();
  })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'story_likes' }, payload => {
   if (payload.new?.user_id !== currentUser?.id) {
    invalidateActivityCacheAndRefreshIfVisible();
   }
  })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'highlights' }, payload => {
   const targetUid = payload.new?.user_id || payload.old?.user_id;
   if (targetUid) {
    delete highlightsCacheByUser[targetUid];
    ogCache.set('highlights_map', highlightsCacheByUser);
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
    ogCache.set('highlights_map', highlightsCacheByUser);
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
   if (!newMsg || newMsg.sender_id === currentUser?.id) return;

   document.getElementById('navUnreadDot')?.classList.add('active');
   cachedConversationsList = null;
   ogCache.remove('conversations');
   prefetchedConversationIds.delete(newMsg.conversation_id);

   if (document.getElementById('messagesPage')?.classList.contains('active')) {
    loadConversations();
   }
   if (activeConversationId === newMsg.conversation_id && !renderedMessageIds.has(newMsg.id)) {
    appendChatMessageNode(newMsg);
    scrollToBottomChat();
   }
  })
  .subscribe();

 postsRealtimeChannel = db.channel('global-posts-feed')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, async payload => {
   const newPost = payload.new;
   if (!newPost || loadedPostIds.has(newPost.id) || !currentUser) return;

   let isAllowed = newPost.user_id === currentUser.id;
   if (!isAllowed) {
    if (Array.isArray(cachedFollowingIds)) {
     isAllowed = cachedFollowingIds.includes(newPost.user_id);
    } else {
     const { data: followCheck } = await db.from('follows')
      .select('following_id')
      .eq('follower_id', currentUser.id)
      .eq('following_id', newPost.user_id)
      .maybeSingle();
     isAllowed = !!followCheck;
    }
   }
   if (!isAllowed) return;

   if (!profilesCache[newPost.user_id]) {
    const { data: prof } = await db.from('og_profiles')
     .select(PROFILE_MINI_FIELDS)
     .eq('id', newPost.user_id)
     .maybeSingle();
    if (prof) setCachedProfile(prof, true);
   }

   if (cachedFeedPosts) {
    cachedFeedPosts.unshift(newPost);
    ogCache.set('feed_posts', cachedFeedPosts.slice(0, 30));
   }
   prependSinglePostToFeed(newPost);
  })
  .subscribe();
}
