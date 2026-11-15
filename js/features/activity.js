/* Depende de: config.js (db); state.js (currentUser, profilesCache); utils.js (formatDate,
   createAvatarNode)
   En tiempo de ejecución usa funciones de otros módulos: showAuthOverlay (auth.js),
   openPublicProfile (profile.js)
   Expone: loadActivity, renderActivityDOM, loadUserOwnActivity */
async function loadActivity() {
 const container = document.getElementById('activitylist');
 if (!currentUser) { showAuthOverlay(); return; }

 try {
  const { data: ownPosts } = await db.from('posts').select('id').eq('user_id', currentUser.id);
  const postIds = (ownPosts || []).map(p => p.id);

  const [followsResult, likesResult, commentsResult] = await Promise.all([
   db.from('follows').select('follower_id,created_at').eq('following_id', currentUser.id).order('created_at', { ascending: false }).limit(30),
   postIds.length ? db.from('likes').select('user_id,post_id,created_at').in('post_id', postIds).order('created_at', { ascending: false }).limit(40) : Promise.resolve({ data: [] }),
   postIds.length ? db.from('comments').select('id,user_id,post_id,content,created_at').in('post_id', postIds).order('created_at', { ascending: false }).limit(40) : Promise.resolve({ data: [] })
  ]);

  const events = [];
  (followsResult.data || []).forEach(f => { if (f.follower_id !== currentUser.id) events.push({ type: 'follow', user_id: f.follower_id, created_at: f.created_at }); });
  (likesResult.data || []).forEach(l => { if (l.user_id !== currentUser.id) events.push({ type: 'like', user_id: l.user_id, created_at: l.created_at }); });
  (commentsResult.data || []).forEach(c => { if (c.user_id !== currentUser.id) events.push({ type: 'comment', user_id: c.user_id, content: c.content, created_at: c.created_at }); });

  events.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  renderActivityDOM(events, container);
 } catch (e) {
  container.textContent = 'No se pudo cargar la actividad.';
 }
}

function renderActivityDOM(events, container) {
 if (!events.length) {
  container.innerHTML = '<div class="activity-empty">Todavía no tenés actividad reciente.</div>';
  return;
 }

 (async () => {
  const missing = [...new Set(events.map(e => e.user_id).filter(Boolean))].filter(id => !profilesCache[id]);
  if (missing.length > 0) {
   const { data: newProfiles } = await db.from('profiles').select('id,username,display_name,avatar_url').in('id', missing);
   (newProfiles || []).forEach(p => profilesCache[p.id] = p);
  }

  const fragment = document.createDocumentFragment();
  events.forEach(event => {
   const profile = profilesCache[event.user_id];
   if (!profile) return;

   const item = document.createElement('div');
   item.className = 'activity-item';
   item.append(createAvatarNode(profile, false));

   const info = document.createElement('div');
   info.className = 'activity-info';
   const message = document.createElement('div');
   const name = document.createElement('strong');
   name.textContent = profile.display_name || profile.username;
   message.append(name);

   if (event.type === 'follow') message.append(document.createTextNode(' comenzó a seguirte.'));
   else if (event.type === 'like') message.append(document.createTextNode(' le dio Me gusta a tu publicación.'));
   else if (event.type === 'comment') message.append(document.createTextNode(' comentó tu publicación.'));

   info.append(message);
   if (event.type === 'comment') {
    const cText = document.createElement('div');
    cText.style.color = '#666666';
    cText.style.marginTop = '3px';
    cText.textContent = '“' + event.content + '”';
    info.append(cText);
   }

   const date = document.createElement('div');
   date.className = 'activity-date';
   date.textContent = formatDate(event.created_at);
   info.append(date);

   item.append(info);
   item.onclick = () => openPublicProfile(profile.id);
   fragment.append(item);
  });
  container.replaceChildren(fragment);
 })();
}

async function loadUserOwnActivity() {
 const container = document.getElementById('userOwnActivityContainer');
 if (!currentUser) return;
 container.innerHTML = '<div class="activity-empty">Cargando tu historial...</div>';

 try {
  const [myLikes, myComments, myFollows] = await Promise.all([
   db.from('likes').select('post_id, created_at').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(25),
   db.from('comments').select('post_id, content, created_at').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(25),
   db.from('follows').select('following_id, created_at').eq('follower_id', currentUser.id).order('created_at', { ascending: false }).limit(25)
  ]);

  const events = [];
  (myLikes.data || []).forEach(l => events.push({ type: 'liked_post', post_id: l.post_id, created_at: l.created_at }));
  (myComments.data || []).forEach(c => events.push({ type: 'commented_post', post_id: c.post_id, content: c.content, created_at: c.created_at }));
  (myFollows.data || []).forEach(f => events.push({ type: 'followed_user', user_id: f.following_id, created_at: f.created_at }));

  events.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  if (!events.length) {
   container.innerHTML = '<div class="activity-empty">Aún no realizaste interacciones en ÖG.</div>';
   return;
  }

  const missingUserIds = [...new Set(events.map(e => e.user_id).filter(Boolean))].filter(id => !profilesCache[id]);
  if (missingUserIds.length > 0) {
   const { data: profs } = await db.from('profiles').select('id, username, display_name, avatar_url').in('id', missingUserIds);
   (profs || []).forEach(p => profilesCache[p.id] = p);
  }

  const fragment = document.createDocumentFragment();
  events.forEach(ev => {
   const row = document.createElement('div');
   row.className = 'activity-item';

   const info = document.createElement('div');
   info.className = 'activity-info';

   const text = document.createElement('div');
   const date = document.createElement('div');
   date.className = 'activity-date';
   date.textContent = formatDate(ev.created_at);

   if (ev.type === 'liked_post') {
    text.innerHTML = '❤ Le diste <strong>Me gusta</strong> a una publicación.';
   } else if (ev.type === 'commented_post') {
    text.innerHTML = `💬 Comentaste: <span style="color:#666666">“${ev.content}”</span>`;
   } else if (ev.type === 'followed_user') {
    const p = profilesCache[ev.user_id];
    text.innerHTML = `👤 Empezaste a seguir a <strong>@${p?.username || 'usuario'}</strong>.`;
   }

   info.append(text, date);
   row.append(info);
   fragment.append(row);
  });

  container.replaceChildren(fragment);
 } catch (e) {
  container.innerHTML = '<div class="activity-empty">No se pudo cargar el historial.</div>';
 }
}

