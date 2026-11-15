/* Depende de: state.js (onlineUsersMap, myProfile); openPostDetail (app.js, luego feed.js) en tiempo de ejecución
   Expone: status, formatDate, timeAgo, setPreviewBlobUrl, setAvatarContent,
   createAvatarNode, updateNavAvatarUI, renderPostsGrid */
function status(id, message) {
 const el = document.getElementById(id);
 if (el) el.textContent = message;
}

function formatDate(date) {
 return new Date(date).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
}

function timeAgo(dateString) {
 const diff = Math.floor((new Date() - new Date(dateString)) / 1000);
 if (diff < 60) return 'Ahora';
 if (diff < 3600) return Math.floor(diff / 60) + ' min';
 if (diff < 86400) return Math.floor(diff / 3600) + ' h';
 return Math.floor(diff / 86400) + ' d';
}

function setPreviewBlobUrl(imgElement, blob) {
 if (!imgElement) return;
 if (imgElement.dataset.blobUrl) {
  URL.revokeObjectURL(imgElement.dataset.blobUrl);
 }
 const url = URL.createObjectURL(blob);
 imgElement.dataset.blobUrl = url;
 imgElement.src = url;
}

function setAvatarContent(container, avatarUrl, fallbackEmoji = '👤') {
 if (!container) return;
 container.replaceChildren();
 if (avatarUrl) {
  const img = document.createElement('img');
  img.src = avatarUrl;
  img.alt = 'Avatar';
  img.loading = 'lazy';
  container.append(img);
 } else {
  container.textContent = fallbackEmoji;
 }
}

function createAvatarNode(profile, isStoryActive = false) {
 const container = document.createElement('div');
 container.className = 'story-avatar-container';

 const inner = document.createElement('div');
 inner.className = 'story-avatar-inner';

 if (profile?.avatar_url) {
  const img = document.createElement('img');
  img.src = profile.avatar_url;
  img.alt = 'Avatar';
  img.loading = 'lazy';
  inner.append(img);
 } else {
  const placeholder = document.createElement('div');
  placeholder.style.fontSize = '20px';
  placeholder.textContent = '👤';
  inner.append(placeholder);
 }
 container.append(inner);

 const dot = document.createElement('span');
 dot.className = 'online-dot';
 if (profile?.id && onlineUsersMap[profile.id]) {
  dot.classList.add('active');
 }
 dot.id = `online-dot-${profile?.id}`;
 container.append(dot);

 return container;
}

function updateNavAvatarUI() {
 const navContainer = document.getElementById('navAvatarContainer');
 if (!navContainer) return;

 const dot = document.getElementById('navOnlineDot');
 navContainer.replaceChildren();

 if (myProfile?.avatar_url) {
  const img = document.createElement('img');
  img.src = myProfile.avatar_url;
  img.alt = 'Perfil';
  img.loading = 'lazy';
  navContainer.append(img);
 } else {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.style.width = '16px';
  svg.style.height = '16px';
  svg.innerHTML = '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>';
  navContainer.append(svg);
 }
 if (dot) navContainer.append(dot);
}

function renderPostsGrid(posts, gridElement, emptyMessage) {
 if (!gridElement) return;
 gridElement.replaceChildren();
 if (!posts || !posts.length) {
  gridElement.innerHTML = `<div class="grid-empty-msg">${emptyMessage}</div>`;
  return;
 }

 const fragment = document.createDocumentFragment();
 posts.forEach(post => {
  const item = document.createElement('div');
  item.className = 'ig-grid-item';
  item.onclick = () => openPostDetail(post);

  if (post.image_url) {
   const img = document.createElement('img');
   img.src = post.image_url;
   img.loading = 'lazy';
   item.append(img);
  } else {
   item.textContent = (post.content || '').slice(0, 55);
  }
  fragment.append(item);
 });
 gridElement.replaceChildren(fragment);
}
