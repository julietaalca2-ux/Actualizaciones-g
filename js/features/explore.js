/* Depende de: config.js (db); state.js (currentUser, profilesCache, searchTimer);
   utils.js (createAvatarNode)
   En tiempo de ejecución usa funciones de otros módulos: openPostDetail (feed.js),
   openPublicProfile (profile.js)
   Expone: loadExploreGrid, handleExploreSearchFocus, handleExploreSearchInput,
   resetExploreSearch, switchSearchTab, executeAdvancedSearch */
async function loadExploreGrid() {
 const grid = document.getElementById('exploreGrid');
 const { data: posts } = await db.from('posts').select('*').order('created_at', { ascending: false });
 if (!posts || !posts.length) return;

 const fragment = document.createDocumentFragment();
 posts.forEach(post => {
  const item = document.createElement('div');
  item.className = 'explore-grid-item';
  item.onclick = () => openPostDetail(post);
  if (post.image_url) {
   const img = document.createElement('img');
   img.src = post.image_url;
   item.append(img);
  } else {
   item.textContent = (post.content || '').slice(0, 45);
  }
  const badge = document.createElement('div');
  badge.className = 'explore-grid-badge';
  badge.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg> <span data-post-views="${post.id}">${post.views || 0}</span>`;
  item.append(badge);
  fragment.append(item);
 });
 grid.replaceChildren(fragment);
}

function handleExploreSearchFocus() {
 const val = document.getElementById('search').value.trim();
 if (val.length >= 1) {
  document.getElementById('searchCategoriesBar').classList.add('active');
  document.getElementById('exploreDefaultView').classList.remove('active');
  document.getElementById('exploreSearchResultsView').classList.add('active');
 }
}

function handleExploreSearchInput() {
 clearTimeout(searchTimer);
 const val = document.getElementById('search').value.trim();
 const catBar = document.getElementById('searchCategoriesBar');
 const defaultView = document.getElementById('exploreDefaultView');
 const resultsView = document.getElementById('exploreSearchResultsView');

 if (val.length === 0) {
  resetExploreSearch();
  return;
 }

 catBar.classList.add('active');
 defaultView.classList.remove('active');
 resultsView.classList.add('active');

 searchTimer = setTimeout(() => executeAdvancedSearch(val), 250);
}

function resetExploreSearch() {
 document.getElementById('searchCategoriesBar').classList.remove('active');
 document.getElementById('exploreDefaultView').classList.add('active');
 document.getElementById('exploreSearchResultsView').classList.remove('active');
 document.getElementById('searchForYouResults').replaceChildren();
 document.getElementById('searchProfilesResults').replaceChildren();
}

function switchSearchTab(tabKey, btnElement) {
 document.querySelectorAll('.search-cat-tab').forEach(b => b.classList.remove('active'));
 btnElement.classList.add('active');
 document.querySelectorAll('.search-tab-content').forEach(c => { c.style.display = 'none'; });
 const targetTab = document.getElementById(`searchTab-${tabKey}`);
 if (targetTab) targetTab.style.display = 'block';
}

async function executeAdvancedSearch(queryText) {
 const query = queryText.toLowerCase();

 const { data: profilesData } = await db.from('profiles')
  .select('id, username, display_name, avatar_url')
  .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
  .limit(15);

 const profilesContainer = document.getElementById('searchProfilesResults');
 profilesContainer.replaceChildren();

 if (!profilesData || !profilesData.length) {
  profilesContainer.innerHTML = '<div class="activity-empty">No se encontraron perfiles.</div>';
 } else {
  const profileFragment = document.createDocumentFragment();
  profilesData.forEach(profile => {
   if (profile.id === currentUser?.id) return;
   profilesCache[profile.id] = profile;
   const item = document.createElement('div');
   item.className = 'public-user';
   item.style.padding = '8px 16px';
   item.append(createAvatarNode(profile, false));
   const info = document.createElement('div');
   info.className = 'public-user-info';
   info.innerHTML = `<strong>${profile.display_name || profile.username}</strong><small>@${profile.username}</small>`;
   item.append(info);
   item.onclick = () => openPublicProfile(profile.id);
   profileFragment.append(item);
  });
  profilesContainer.replaceChildren(profileFragment);
 }

 const { data: postsData } = await db.from('posts')
  .select('*')
  .ilike('content', `%${query}%`)
  .order('created_at', { ascending: false })
  .limit(18);

 const forYouContainer = document.getElementById('searchForYouResults');
 forYouContainer.replaceChildren();

 if (!postsData || !postsData.length) {
  forYouContainer.innerHTML = '<div class="activity-empty" style="grid-column: span 3;">No hay publicaciones relacionadas.</div>';
 } else {
  const postsFragment = document.createDocumentFragment();
  postsData.forEach(post => {
   const item = document.createElement('div');
   item.className = 'explore-grid-item';
   item.onclick = () => openPostDetail(post);
   if (post.image_url) {
    const img = document.createElement('img');
    img.src = post.image_url;
    item.append(img);
   } else {
    item.textContent = (post.content || '').slice(0, 45);
   }
   postsFragment.append(item);
  });
  forYouContainer.replaceChildren(postsFragment);
 }
}

