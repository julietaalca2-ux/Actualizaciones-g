/* Marca un elemento para que verification.js le ponga la insignia (se repinta si cambió el texto) */
function markVerifyUser(el, userId) {
 if (!el || !userId) return;
 el.removeAttribute('data-verify-done');
 el.setAttribute('data-verify-user', userId);
 if (window.VerificationSystem) VerificationSystem.decorateUsers(el.parentNode || document);
}

/* Depende de: config.js (db); state.js (currentUser, myProfile, viewedProfile, isFollowing,
   profilesCache, stagedAvatarBlob, cachedFeedPosts, cachedFollowingIds, highlightsCacheByUser);
   utils.js (setAvatarContent, setPreviewBlobUrl, revokePreviewBlobUrl, compressImageBlob,
   createAvatarNode, updateNavAvatarUI, renderPostsGrid, ogCache, setCachedProfile,
   PROFILE_SELECT_FIELDS, PROFILE_MINI_FIELDS, POST_SELECT_FIELDS);
   core/navigation.js (showTab)
   En tiempo de ejecución usa funciones de otros módulos: loadSavedPostsProfileGrid,
   loadInitialPosts, openPostDetail (feed.js), loadHighlights (highlights.js),
   loadStoriesData (stories.js)
   Expone: updateProfileUI, openEditProfileModal, closeEditProfileModal, stageImage,
   saveFullProfile, loadMyPostsGrid, switchProfileTab, switchPublicProfileTab,
   shareProfileLink, openPublicProfile, loadPublicCounts, checkFollowStatus, toggleFollow,
   loadPublicUserPosts, loadFollowCounts, openFollowersModal, openFollowingModal,
   renderUsersInFollowModal, closeFollowListModal */

function updateProfileUI() {
 if (!currentUser) {
  document.getElementById('profile-actions').style.display = 'none';
  return;
 }

 document.getElementById('profile-actions').style.display = 'flex';
 document.getElementById('myname').textContent = myProfile?.display_name || myProfile?.username || 'Mi perfil';
 markVerifyUser(document.getElementById('myname'), myProfile?.id || currentUser?.id);
 document.getElementById('mypronouns').textContent = myProfile?.pronouns ? `· ${myProfile.pronouns}` : '';
 document.getElementById('myusername').textContent = '@' + (myProfile?.username || '');
 document.getElementById('mybio').textContent = myProfile?.bio || '';

 const websiteContainer = document.getElementById('myWebsiteContainer');

 if (myProfile?.website) {
  document.getElementById('myWebsiteLink').href = myProfile.website;
  document.getElementById('myWebsiteText').textContent = myProfile.website.replace(/^https?:\/\//, '').replace(/\/$/, '');
  websiteContainer.style.display = 'block';
 } else {
  websiteContainer.style.display = 'none';
 }

 setAvatarContent(document.getElementById('myavatar'), myProfile?.avatar_url);

 loadFollowCounts();
 loadMyPostsGrid();
 loadSavedPostsProfileGrid();
 loadHighlights(currentUser.id, 'highlightsScrollContainer');
 updateNavAvatarUI();
}

function openEditProfileModal() {
 stagedAvatarBlob = null;

 const avatarPreviewBox = document.getElementById('modalAvatarPreviewBox');

 setAvatarContent(avatarPreviewBox, myProfile?.avatar_url, '👤');

 document.getElementById('editname').value = myProfile?.display_name || '';
 document.getElementById('editusername').value = myProfile?.username || '';
 document.getElementById('editpronouns').value = myProfile?.pronouns || '';
 document.getElementById('editwebsite').value = myProfile?.website || '';
 document.getElementById('editgender').value = myProfile?.gender || '';
 document.getElementById('editbio').value = myProfile?.bio || '';

 document.getElementById('editProfileModal').classList.add('active');
}

function closeEditProfileModal() {
 stagedAvatarBlob = null;
 const previewImg = document.querySelector('#modalAvatarPreviewBox img');
 if (previewImg) revokePreviewBlobUrl(previewImg);
 document.getElementById('editProfileModal').classList.remove('active');
}

async function stageImage(type, input) {
 const file = input.files?.[0];

 if (!file) return;
 input.value = '';

 if (type === 'avatar') {
  if (!file.type.startsWith('image/')) {
   alert('Seleccioná un archivo de imagen válido.');
   return;
  }

  const compressed = await compressImageBlob(file, 400, 0.84);
  stagedAvatarBlob = compressed;

  const box = document.getElementById('modalAvatarPreviewBox');
  box.replaceChildren();

  const img = document.createElement('img');
  img.decoding = 'async';
  setPreviewBlobUrl(img, compressed);
  box.append(img);
 }
}

async function saveFullProfile() {
 if (!currentUser) {
  alert('Debes iniciar sesión para editar tu perfil.');
  return;
 }

 const saveButton = document.querySelector('#editProfileModal button[onclick="saveFullProfile()"]');

 try {
  if (saveButton) {
   saveButton.disabled = true;
   saveButton.textContent = 'Guardando...';
  }

  const display_name = document.getElementById('editname').value.trim();
  const username = document.getElementById('editusername').value.trim().toLowerCase();
  const pronouns = document.getElementById('editpronouns').value.trim();
  const website = document.getElementById('editwebsite').value.trim();
  const gender = document.getElementById('editgender').value;
  const bio = document.getElementById('editbio').value.trim();

  if (!username) {
   throw new Error('El nombre de usuario es obligatorio.');
  }

  let avatarUrl = myProfile?.avatar_url || null;

  // SUBIR FOTO DE PERFIL
  if (stagedAvatarBlob) {
   const file = stagedAvatarBlob;
   const extension = file.type === 'image/jpeg' ? 'jpg' : (file.name?.split('.').pop()?.toLowerCase() || 'jpg');
   const path = `${currentUser.id}/avatar-${Date.now()}.${extension}`;

   const { error: uploadError } = await db.storage
    .from('og-media')
    .upload(path, file, {
     contentType: file.type || 'image/jpeg',
     upsert: false
    });

   if (uploadError) {
    throw new Error('Error al subir la foto: ' + uploadError.message);
   }

   const { data: publicData } = db.storage
    .from('og-media')
    .getPublicUrl(path);

   avatarUrl = publicData.publicUrl;
  }

  // ACTUALIZAR PERFIL EN SUPABASE
  const { data, error } = await db
   .from('og_profiles')
   .update({
    display_name,
    username,
    pronouns,
    website,
    gender,
    bio,
    avatar_url: avatarUrl
   })
   .eq('id', currentUser.id)
   .select(PROFILE_SELECT_FIELDS)
   .single();

  if (error) {
   throw new Error('Error al guardar el perfil: ' + error.message);
  }

  if (!data) {
   throw new Error('Supabase no devolvió los datos actualizados.');
  }

  // ACTUALIZAR ESTADO LOCAL Y CACHÉ
  myProfile = data;
  setCachedProfile(data, true);
  ogCache.set('my_profile', data);
  stagedAvatarBlob = null;

  // ACTUALIZAR INTERFAZ
  updateProfileUI();

  closeEditProfileModal();

  alert('¡Tu perfil se actualizó correctamente!');

 } catch (error) {
  console.error('ÖG - Error actualizando perfil:', error);
  alert(error.message || 'No se pudieron guardar los cambios.');

 } finally {
  if (saveButton) {
   saveButton.disabled = false;
   saveButton.textContent = 'Guardar cambios';
  }
 }
}

function renderMyPostsListToGrid(posts, grid) {
 document.getElementById('mypostscount').textContent = posts ? posts.length : 0;
 grid.replaceChildren();

 if (!posts || !posts.length) {
  grid.innerHTML = '<div class="grid-empty-msg">Aún no tienes publicaciones.</div>';
  return;
 }

 const pinnedIds = JSON.parse(localStorage.getItem('og_pinned_posts_' + currentUser.id) || '[]');
 const sorted = [...posts].sort((a, b) => {
  const aPinned = pinnedIds.includes(a.id);
  const bPinned = pinnedIds.includes(b.id);
  if (aPinned && !bPinned) return -1;
  if (!aPinned && bPinned) return 1;
  return new Date(b.created_at) - new Date(a.created_at);
 });

 const fragment = document.createDocumentFragment();

 sorted.forEach(post => {
  const item = document.createElement('div');
  item.className = 'ig-grid-item';
  item.onclick = () => openPostDetail(post);

  const isPinned = pinnedIds.includes(post.id);

  if (isPinned) {
   const badge = document.createElement('div');
   badge.className = 'pinned-post-badge';
   badge.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Fijada`;
   item.append(badge);
  }

  item.oncontextmenu = e => {
   e.preventDefault();

   const action = isPinned ? 'Quitar de fijados' : 'Fijar en el perfil';

   if (confirm(`${action}?`)) {
    let currentPinned = JSON.parse(localStorage.getItem('og_pinned_posts_' + currentUser.id) || '[]');

    if (isPinned) {
     currentPinned = currentPinned.filter(id => id !== post.id);
    } else {
     if (currentPinned.length >= 3) return alert('Puedes fijar un máximo de 3 publicaciones.');
     currentPinned.push(post.id);
    }

    localStorage.setItem('og_pinned_posts_' + currentUser.id, JSON.stringify(currentPinned));
    loadMyPostsGrid();
   }
  };

  if (post.image_url) {
   const img = document.createElement('img');
   img.src = post.image_url;
   img.loading = 'lazy';
   img.decoding = 'async';
   item.append(img);
  } else {
   item.textContent = (post.content || '').slice(0, 55);
  }

  fragment.append(item);
 });

 grid.replaceChildren(fragment);
}

async function loadMyPostsGrid() {
 if (!currentUser) return;

 const grid = document.getElementById('mypostsgrid');
 const cachedMyPosts = ogCache.get(`user_posts_${currentUser.id}`, 1000 * 60 * 60 * 12);
 if (Array.isArray(cachedMyPosts)) {
  renderMyPostsListToGrid(cachedMyPosts, grid);
 }

 const { data: posts } = await db.from('posts')
  .select(POST_SELECT_FIELDS)
  .eq('user_id', currentUser.id)
  .order('created_at', { ascending: false });

 if (posts) {
  ogCache.set(`user_posts_${currentUser.id}`, posts);
  renderMyPostsListToGrid(posts, grid);
 }
}

function switchProfileTab(tabKey) {
 document.querySelectorAll('.profile-tab-btn').forEach(b => b.classList.remove('active'));
 document.querySelectorAll('.profile-tab-content-pane').forEach(p => p.classList.remove('active'));

 document.getElementById(`tabBtn-${tabKey}`).classList.add('active');
 document.getElementById(`profileTabPane-${tabKey}`).classList.add('active');

 if (tabKey === 'saved') loadSavedPostsProfileGrid();
}

function switchPublicProfileTab(tabKey) {
 document.querySelectorAll('#publicprofile .profile-tab-btn').forEach(b => b.classList.remove('active'));
 document.querySelectorAll('#publicprofile .profile-tab-content-pane').forEach(p => p.classList.remove('active'));

 document.getElementById(`pubTabBtn-${tabKey}`).classList.add('active');
 document.getElementById(`pubTabPane-${tabKey}`).classList.add('active');
}

function shareProfileLink() {
 const profileUrl = window.location.href.split('#')[0] + '#' + (myProfile?.username || currentUser?.id);

 if (navigator.clipboard) {
  navigator.clipboard.writeText(profileUrl);
  alert('¡Enlace del perfil copiado al portapapeles!');
 } else {
  prompt('Copia tu enlace de perfil:', profileUrl);
 }
}

function renderPublicProfileHeader(profile) {
 viewedProfile = profile;
 document.getElementById('publicname').textContent = profile.display_name || profile.username;
 markVerifyUser(document.getElementById('publicname'), profile.id);
 document.getElementById('publicpronouns').textContent = profile.pronouns ? `· ${profile.pronouns}` : '';
 document.getElementById('publicheadername').textContent = profile.username;
 document.getElementById('publicusername').textContent = '@' + profile.username;
 document.getElementById('publicbio').textContent = profile.bio || '';

 const websiteContainer = document.getElementById('publicWebsiteContainer');

 if (profile.website) {
  document.getElementById('publicWebsiteLink').href = profile.website;
  document.getElementById('publicWebsiteText').textContent = profile.website.replace(/^https?:\/\//, '').replace(/\/$/, '');
  websiteContainer.style.display = 'block';
 } else {
  websiteContainer.style.display = 'none';
 }

 setAvatarContent(document.getElementById('publicavatar'), profile.avatar_url);
}

async function openPublicProfile(userId) {
 if (!userId) return;
 if (currentUser && userId === currentUser.id) {
  showTab('profile');
  return;
 }

 // Carga instantánea desde caché de memoria/SWR si el perfil ya fue visto o precargado
 const cachedProf = profilesCache[userId];
 const cachedUserPosts = ogCache.get(`user_posts_${userId}`, 1000 * 60 * 60 * 6);

 if (cachedProf) {
  renderPublicProfileHeader(cachedProf);
  showTab('publicprofile');
  if (Array.isArray(cachedUserPosts)) {
   document.getElementById('publicpostscount').textContent = cachedUserPosts.length;
   renderPostsGrid(cachedUserPosts, document.getElementById('publicposts'), 'No hay publicaciones.');
  }
  if (Array.isArray(highlightsCacheByUser[userId])) {
   loadHighlights(userId, 'publicHighlightsScrollContainer');
  }
 }

 const { data: profile } = await db.from('og_profiles')
  .select(PROFILE_SELECT_FIELDS)
  .eq('id', userId)
  .single();

 if (!profile) return;

 const merged = setCachedProfile(profile, true) || profile;
 renderPublicProfileHeader(merged);

 if (!cachedProf) {
  showTab('publicprofile');
 }

 await Promise.all([
  checkFollowStatus(userId),
  loadPublicUserPosts(userId),
  loadPublicCounts(userId),
  loadHighlights(userId, 'publicHighlightsScrollContainer')
 ]);
}

async function loadPublicCounts(userId) {
 const [followers, following, posts] = await Promise.all([
  db.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId),
  db.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
  db.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', userId)
 ]);

 document.getElementById('publicfollowerscount').textContent = followers.count || 0;
 document.getElementById('publicfollowingcount').textContent = following.count || 0;
 document.getElementById('publicpostscount').textContent = posts.count || 0;
}

async function checkFollowStatus(userId) {
 if (!currentUser) return;

 const { data } = await db.from('follows')
  .select('following_id')
  .eq('follower_id', currentUser.id)
  .eq('following_id', userId)
  .maybeSingle();

 isFollowing = !!data;

 const btn = document.getElementById('publicfollow');
 btn.textContent = isFollowing ? 'Siguiendo' : 'Seguir';
 btn.classList.toggle('primary-action', !isFollowing);
}

async function toggleFollow() {
 if (!currentUser || !viewedProfile) return;

 const btn = document.getElementById('publicfollow');

 if (isFollowing) {
  await db.from('follows').delete()
   .eq('follower_id', currentUser.id)
   .eq('following_id', viewedProfile.id);

  isFollowing = false;
  btn.textContent = 'Seguir';
  btn.classList.add('primary-action');

 } else {
  await db.from('follows').insert({
   follower_id: currentUser.id,
   following_id: viewedProfile.id
  });

  isFollowing = true;
  btn.textContent = 'Siguiendo';
  btn.classList.remove('primary-action');
 }

 cachedFollowingIds = null;
 ogCache.remove('following_ids');
 cachedFeedPosts = null;
 ogCache.remove('feed_posts');

 loadPublicCounts(viewedProfile.id);
 loadFollowCounts();

 await Promise.all([
  loadInitialPosts(),
  loadStoriesData()
 ]);
}

async function loadPublicUserPosts(userId) {
 const grid = document.getElementById('publicposts');

 const { data: posts } = await db.from('posts')
  .select(POST_SELECT_FIELDS)
  .eq('user_id', userId)
  .order('created_at', { ascending: false });

 if (posts) {
  ogCache.set(`user_posts_${userId}`, posts);
 }
 renderPostsGrid(posts, grid, 'No hay publicaciones.');
}

async function loadFollowCounts() {
 if (!currentUser) return;

 const [followers, following] = await Promise.all([
  db.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', currentUser.id),
  db.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', currentUser.id)
 ]);

 document.getElementById('myfollowerscount').textContent = followers.count || 0;
 document.getElementById('myfollowingcount').textContent = following.count || 0;
}

async function openFollowersModal(targetId = null) {
 const userId = targetId || currentUser?.id;
 if (!userId) return;

 document.getElementById('followModalTitle').textContent = 'Seguidores';
 document.getElementById('followListModal').classList.add('open');

 const { data } = await db.from('follows')
  .select('follower_id')
  .eq('following_id', userId);

 if (data) renderUsersInFollowModal(data.map(f => f.follower_id));
}

async function openFollowingModal(targetId = null) {
 const userId = targetId || currentUser?.id;
 if (!userId) return;

 document.getElementById('followModalTitle').textContent = 'Siguiendo';
 document.getElementById('followListModal').classList.add('open');

 const { data } = await db.from('follows')
  .select('following_id')
  .eq('follower_id', userId);

 if (data) renderUsersInFollowModal(data.map(f => f.following_id));
}

async function renderUsersInFollowModal(userIds) {
 const container = document.getElementById('followListContainer');

 const missing = userIds.filter(id => !profilesCache[id]);

 if (missing.length > 0) {
  const { data: profs } = await db.from('og_profiles')
   .select(PROFILE_MINI_FIELDS)
   .in('id', missing);

  (profs || []).forEach(p => setCachedProfile(p, false));
 }

 const fragment = document.createDocumentFragment();

 userIds.forEach(id => {
  const profile = profilesCache[id];
  if (!profile) return;

  const item = document.createElement('div');
  item.className = 'public-user';
  item.append(createAvatarNode(profile, false));

  const info = document.createElement('div');
  info.className = 'public-user-info';
  info.innerHTML = `<strong data-verify-user="${profile.id}">${profile.display_name || profile.username}</strong><small>@${profile.username}</small>`;

  item.append(info);

  item.onclick = () => {
   closeFollowListModal();
   openPublicProfile(profile.id);
  };

  fragment.append(item);
 });

 container.replaceChildren(fragment);
}

function closeFollowListModal() {
 document.getElementById('followListModal').classList.remove('open');
}
