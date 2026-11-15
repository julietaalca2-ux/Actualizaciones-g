/* Depende de: config.js (db); state.js (currentUser, myProfile, viewedProfile, profilesCache,
   highlightsCacheByUser, stagedHighlightBlob, pendingStoryImageForHighlight,
   currentHighlightItems, currentHighlightIndex, isSavingHighlight, currentActiveStoryId);
   utils.js (setAvatarContent); features/stories.js (renderProgressSegments)
   Expone: createNewHighlightModal, closeHighlightModal, stageHighlightCover, saveNewHighlight,
   fetchUserHighlightsFromSupabase, openAddToHighlightModal, closeAddToHighlightModal,
   createNewHighlightFromViewer, openHighlightViewer, renderCurrentHighlightItem,
   nextHighlightSlide, prevHighlightSlide, closeHighlightViewer, loadHighlights
   Registra: gestos táctiles del visor de destacadas */
function createNewHighlightModal(initialImageUrl = null) {
 document.getElementById('highlightTitleInput').value = '';
 stagedHighlightBlob = null;
 pendingStoryImageForHighlight = initialImageUrl;
 const saveBtn = document.getElementById('saveHighlightBtn');
 if (saveBtn) {
  saveBtn.disabled = false;
  saveBtn.textContent = 'Publicar destacada';
 }
 document.getElementById('highlightModal').classList.add('active');
}

function closeHighlightModal() {
 pendingStoryImageForHighlight = null;
 document.getElementById('highlightModal').classList.remove('active');
}

function stageHighlightCover(input) {
 const file = input.files?.[0];
 if (!file) return;
 stagedHighlightBlob = file;
 alert('Imagen de portada seleccionada.');
 input.value = '';
}

async function saveNewHighlight() {
 if (!currentUser || isSavingHighlight) return;
 const title = document.getElementById('highlightTitleInput').value.trim();
 if (!title) return alert('Ingresá un título para la historia destacada.');
 if (!stagedHighlightBlob && !pendingStoryImageForHighlight) {
  return alert('Seleccioná una imagen de portada.');
 }

 isSavingHighlight = true;
 const saveBtn = document.getElementById('saveHighlightBtn');
 if (saveBtn) {
  saveBtn.disabled = true;
  saveBtn.textContent = 'Guardando...';
 }

 try {
  let coverUrl = pendingStoryImageForHighlight || null;

  if (stagedHighlightBlob) {
   const uniqueSuffix = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
   const path = `${currentUser.id}/highlight-${uniqueSuffix}.jpg`;
   const { error: uploadError } = await db.storage.from('og-media').upload(path, stagedHighlightBlob, {
    contentType: 'image/jpeg',
    upsert: false
   });
   if (uploadError) throw uploadError;
   coverUrl = db.storage.from('og-media').getPublicUrl(path).data.publicUrl;
  }

  const { data: createdHighlight, error: hlError } = await db.from('highlights')
   .insert({
    user_id: currentUser.id,
    title,
    cover_url: coverUrl
   })
   .select()
   .single();

  if (hlError) throw hlError;

  const initialItemsToInsert = [];
  if (coverUrl) {
   initialItemsToInsert.push({
    highlight_id: createdHighlight.id,
    user_id: currentUser.id,
    image_url: coverUrl,
    position: 0
   });
  }
  if (pendingStoryImageForHighlight && pendingStoryImageForHighlight !== coverUrl) {
   initialItemsToInsert.push({
    highlight_id: createdHighlight.id,
    user_id: currentUser.id,
    image_url: pendingStoryImageForHighlight,
    position: initialItemsToInsert.length
   });
  }

  if (initialItemsToInsert.length > 0) {
   const { error: itemsError } = await db.from('highlight_items').insert(initialItemsToInsert);
   if (itemsError) throw itemsError;
  }

  delete highlightsCacheByUser[currentUser.id];
  closeHighlightModal();
  await loadHighlights(currentUser.id, 'highlightsScrollContainer');
 } catch (e) {
  alert('Error al guardar la historia destacada en la nube.');
  if (saveBtn) {
   saveBtn.disabled = false;
   saveBtn.textContent = 'Publicar destacada';
  }
 } finally {
  isSavingHighlight = false;
 }
}

async function fetchUserHighlightsFromSupabase(userId) {
 if (!userId) return [];
 const { data: highlightsData, error: hlErr } = await db.from('highlights')
  .select('id, user_id, title, cover_url, created_at')
  .eq('user_id', userId)
  .order('created_at', { ascending: true });

 if (hlErr || !highlightsData) return [];
 if (!highlightsData.length) {
  highlightsCacheByUser[userId] = [];
  return [];
 }

 const highlightIds = highlightsData.map(h => h.id);
 const { data: itemsData } = await db.from('highlight_items')
  .select('id, highlight_id, image_url, position, created_at')
  .in('highlight_id', highlightIds)
  .order('position', { ascending: true })
  .order('created_at', { ascending: true });

 const itemsByHighlightId = {};
 (itemsData || []).forEach(it => {
  if (!itemsByHighlightId[it.highlight_id]) itemsByHighlightId[it.highlight_id] = [];
  itemsByHighlightId[it.highlight_id].push(it.image_url);
 });

 const enriched = highlightsData.map(h => ({
  ...h,
  items: itemsByHighlightId[h.id] || []
 }));

 highlightsCacheByUser[userId] = enriched;
 return enriched;
}

async function openAddToHighlightModal() {
 if (!currentActiveStoryId || !currentUser) return;
 const listContainer = document.getElementById('addToHighlightList');
 listContainer.innerHTML = '<div class="activity-empty">Cargando destacadas...</div>';
 document.getElementById('addToHighlightModal').classList.add('active');

 const storyImageUrl = document.getElementById('storyImage').src;
 const highlights = await fetchUserHighlightsFromSupabase(currentUser.id);

 listContainer.replaceChildren();
 if (!highlights.length) {
  listContainer.innerHTML = '<div class="activity-empty">No tienes historias destacadas creadas. Crea una abajo.</div>';
  return;
 }

 const fragment = document.createDocumentFragment();
 highlights.forEach(hl => {
  const btn = document.createElement('button');
  btn.className = 'secondary';
  btn.style.cssText = 'width:100%;text-align:left;display:flex;align-items:center;gap:10px;padding:8px 12px;';

  const alreadyAdded = hl.items && hl.items.includes(storyImageUrl);
  btn.innerHTML = `<span style="font-weight:600;">📁 ${hl.title}</span> <span style="margin-left:auto;font-size:12px;color:${alreadyAdded ? '#22c55e' : '#3b82f6'}">${alreadyAdded ? 'Agregada ✓' : 'Agregar +'}</span>`;

  btn.onclick = async () => {
   if (alreadyAdded) {
    alert('Esta historia ya está en esta destacada.');
    closeAddToHighlightModal();
    return;
   }
   btn.disabled = true;
   const nextPos = Array.isArray(hl.items) ? hl.items.length : 0;

   const { error: insertErr } = await db.from('highlight_items').insert({
    highlight_id: hl.id,
    user_id: currentUser.id,
    image_url: storyImageUrl,
    position: nextPos
   });

   if (insertErr) {
    alert('No se pudo agregar la foto a la destacada.');
    btn.disabled = false;
    return;
   }

   if (!hl.cover_url) {
    await db.from('highlights').update({ cover_url: storyImageUrl }).eq('id', hl.id).eq('user_id', currentUser.id);
   }

   delete highlightsCacheByUser[currentUser.id];
   alert(`Agregada a "${hl.title}"`);
   closeAddToHighlightModal();
   await loadHighlights(currentUser.id, 'highlightsScrollContainer');
  };
  fragment.append(btn);
 });
 listContainer.replaceChildren(fragment);
}

function closeAddToHighlightModal() { document.getElementById('addToHighlightModal').classList.remove('active'); }

function createNewHighlightFromViewer() {
 const storyImageUrl = document.getElementById('storyImage')?.src || null;
 closeAddToHighlightModal();
 createNewHighlightModal(storyImageUrl);
}

function openHighlightViewer(highlightObj, profile) {
 const items = (highlightObj.items && highlightObj.items.length > 0)
  ? highlightObj.items
  : (highlightObj.cover_url ? [highlightObj.cover_url] : []);

 if (!items.length) {
  alert('Esta historia destacada no tiene elementos guardados.');
  return;
 }

 currentHighlightItems = items;
 currentHighlightIndex = 0;

 const viewer = document.getElementById('highlightViewer');
 document.getElementById('highlightViewerUsername').textContent = '@' + (profile?.username || 'usuario');
 document.getElementById('highlightViewerTitleText').textContent = highlightObj.title;
 setAvatarContent(document.getElementById('highlightViewerAvatarInner'), profile?.avatar_url);

 renderCurrentHighlightItem();
 viewer.classList.add('active');
}

function renderCurrentHighlightItem() {
 renderProgressSegments('highlightProgressBars', currentHighlightItems.length, currentHighlightIndex);
 document.getElementById('highlightViewerImage').src = currentHighlightItems[currentHighlightIndex];
 document.getElementById('highlightViewerCounter').textContent = `${currentHighlightIndex + 1} / ${currentHighlightItems.length}`;
}

function nextHighlightSlide() {
 if (!currentHighlightItems.length) return;
 if (currentHighlightIndex < currentHighlightItems.length - 1) {
  currentHighlightIndex++;
  renderCurrentHighlightItem();
 } else {
  closeHighlightViewer();
 }
}

function prevHighlightSlide() {
 if (!currentHighlightItems.length) return;
 if (currentHighlightIndex > 0) {
  currentHighlightIndex--;
  renderCurrentHighlightItem();
 } else {
  renderCurrentHighlightItem();
 }
}

function closeHighlightViewer() {
 currentHighlightItems = [];
 currentHighlightIndex = 0;
 document.getElementById('highlightViewer').classList.remove('active');
}

/* Gestos táctiles y toque en Visor de Destacadas */
(function initHighlightViewerGestures() {
 const area = document.getElementById('highlightContentAreaContainer');
 if (!area) return;
 let startX = 0;
 let startY = 0;

 area.addEventListener('touchstart', e => {
  startX = e.changedTouches[0].clientX;
  startY = e.changedTouches[0].clientY;
 }, { passive: true });

 area.addEventListener('touchend', e => {
  const endX = e.changedTouches[0].clientX;
  const endY = e.changedTouches[0].clientY;
  const diffX = endX - startX;
  const diffY = endY - startY;

  if (Math.abs(diffY) > 90 && diffY > Math.abs(diffX)) {
   closeHighlightViewer();
   return;
  }

  if (Math.abs(diffX) > 40 && Math.abs(diffX) > Math.abs(diffY)) {
   if (diffX < 0) nextHighlightSlide();
   else prevHighlightSlide();
   return;
  }

  const rect = area.getBoundingClientRect();
  const tapX = endX - rect.left;
  if (tapX < rect.width * 0.35) prevHighlightSlide();
  else nextHighlightSlide();
 }, { passive: true });

 area.addEventListener('click', e => {
  if ('ontouchstart' in window) return;
  const rect = area.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  if (clickX < rect.width * 0.35) prevHighlightSlide();
  else nextHighlightSlide();
 });
})();

async function loadHighlights(userId, containerId) {
 const container = document.getElementById(containerId);
 if (!container || !userId) return;

 const isOwner = currentUser && userId === currentUser.id;
 const highlights = await fetchUserHighlightsFromSupabase(userId);
 const profile = profilesCache[userId] || (isOwner ? myProfile : viewedProfile);
 const fragment = document.createDocumentFragment();

 if (isOwner) {
  const newDiv = document.createElement('div');
  newDiv.className = 'highlight-item';
  newDiv.onclick = () => createNewHighlightModal();
  newDiv.innerHTML = `<div class="highlight-circle"><svg viewBox="0 0 24 24" fill="none" stroke="#111111" stroke-width="2" style="width:24px;height:24px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div><span class="highlight-title">Nuevo</span>`;
  fragment.append(newDiv);
 }

 highlights.forEach(h => {
  const item = document.createElement('div');
  item.className = 'highlight-item';
  item.onclick = () => openHighlightViewer(h, profile);

  if (isOwner) {
   item.oncontextmenu = async e => {
    e.preventDefault();
    if (confirm(`¿Eliminar historia destacada "${h.title}"?`)) {
     const { error } = await db.from('highlights').delete().eq('id', h.id).eq('user_id', currentUser.id);
     if (!error) {
      delete highlightsCacheByUser[userId];
      loadHighlights(userId, containerId);
     }
    }
   };
  }

  const circle = document.createElement('div');
  circle.className = 'highlight-circle';
  const coverSrc = h.cover_url || (h.items && h.items[0]) || '';
  if (coverSrc) {
   const img = document.createElement('img');
   img.src = coverSrc;
   img.loading = 'lazy';
   circle.append(img);
  } else {
   circle.textContent = '⭐';
  }

  const title = document.createElement('span');
  title.className = 'highlight-title';
  title.textContent = h.title;

  item.append(circle, title);
  fragment.append(item);
 });

 container.replaceChildren(fragment);
}

