/* Depende de: config.js (db); state.js (currentUser, myProfile, viewedProfile, profilesCache,
   highlightsCacheByUser, stagedHighlightBlob, pendingStoryImageForHighlight,
   currentHighlightItems, currentHighlightIndex, isSavingHighlight, currentActiveStoryId);
   utils.js (setAvatarContent, compressImageBlob, ogCache);
   features/stories.js (renderProgressSegments, setViewerImage, attachStoryViewerGestures, preloadStoryImageUrl)
   Expone: deleteHighlightById, openHighlightManageSheet, closeHighlightManageSheet,
   deleteCurrentHighlight, deleteCurrentHighlightPhoto, createNewHighlightModal, closeHighlightModal, stageHighlightCover, saveNewHighlight,
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

async function stageHighlightCover(input) {
 const file = input.files?.[0];
 if (!file) return;
 input.value = '';
 stagedHighlightBlob = await compressImageBlob(file, 1080, 0.82);
 alert('Imagen de portada seleccionada.');
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
   .select('id, user_id, title, cover_url, created_at')
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
  ogCache.set('highlights_map', highlightsCacheByUser);
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
  ogCache.set('highlights_map', highlightsCacheByUser);
  return [];
 }

 const highlightIds = highlightsData.map(h => h.id);
 const { data: itemsData } = await db.from('highlight_items')
  .select('id, highlight_id, image_url, position, created_at')
  .in('highlight_id', highlightIds)
  .order('position', { ascending: true })
  .order('created_at', { ascending: true });

 const itemsByHighlightId = {};
 const itemIdsByHighlightId = {};
 (itemsData || []).forEach(it => {
  if (!itemsByHighlightId[it.highlight_id]) itemsByHighlightId[it.highlight_id] = [];
  itemsByHighlightId[it.highlight_id].push(it.image_url);
  if (!itemIdsByHighlightId[it.highlight_id]) itemIdsByHighlightId[it.highlight_id] = [];
  itemIdsByHighlightId[it.highlight_id].push(it.id);
 });

 const enriched = highlightsData.map(h => ({
  ...h,
  items: itemsByHighlightId[h.id] || [],
  itemIds: itemIdsByHighlightId[h.id] || []
 }));

 highlightsCacheByUser[userId] = enriched;
 ogCache.set('highlights_map', highlightsCacheByUser);
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
   ogCache.set('highlights_map', highlightsCacheByUser);
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
 const hasItems = highlightObj.items && highlightObj.items.length > 0;
 const items = hasItems
  ? highlightObj.items
  : (highlightObj.cover_url ? [highlightObj.cover_url] : []);

 if (!items.length) {
  alert('Esta historia destacada no tiene elementos guardados.');
  return;
 }

 currentHighlightObj = highlightObj;
 currentHighlightOwnerId = highlightObj.user_id;
 currentHighlightItems = items.slice();
 currentHighlightItemIds = hasItems && Array.isArray(highlightObj.itemIds) ? highlightObj.itemIds.slice() : [];
 currentHighlightIndex = 0;

 const viewer = document.getElementById('highlightViewer');
 document.getElementById('highlightViewerUsername').textContent = '@' + (profile?.username || 'usuario');
 document.getElementById('highlightViewerTitleText').textContent = highlightObj.title;
 setAvatarContent(document.getElementById('highlightViewerAvatarInner'), profile?.avatar_url);

 // Solo el dueño ve el botón de borrar
 const isOwner = !!currentUser && highlightObj.user_id === currentUser.id;
 const manageBtn = document.getElementById('highlightManageBtn');
 if (manageBtn) manageBtn.style.display = isOwner ? 'inline-flex' : 'none';

 renderCurrentHighlightItem();
 viewer.classList.add('active');
}

function renderCurrentHighlightItem() {
 // La barra se llena sola en 5 s y, al terminar, pasa a la siguiente foto
 renderProgressSegments('highlightProgressBars', currentHighlightItems.length, currentHighlightIndex, nextHighlightSlide);
 setViewerImage('highlightViewer', document.getElementById('highlightViewerImage'), currentHighlightItems[currentHighlightIndex]);
 document.getElementById('highlightViewerCounter').textContent = `${currentHighlightIndex + 1} / ${currentHighlightItems.length}`;

 const nextUrl = currentHighlightItems[currentHighlightIndex + 1];
 if (nextUrl && typeof preloadStoryImageUrl === 'function') {
  preloadStoryImageUrl(nextUrl);
 }
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
 if (currentHighlightIndex > 0) currentHighlightIndex--;
 renderCurrentHighlightItem();
}

function closeHighlightViewer() {
 const bars = document.getElementById('highlightProgressBars');
 if (bars) bars.replaceChildren();
 closeHighlightManageSheet();
 currentHighlightItems = [];
 currentHighlightItemIds = [];
 currentHighlightObj = null;
 currentHighlightIndex = 0;
 const viewer = document.getElementById('highlightViewer');
 viewer.classList.remove('active', 'is-held', 'is-loading', 'is-menu-open');
}

/* Gestos del Visor de Destacadas (toque, deslizar y mantener presionado para pausar) */
attachStoryViewerGestures(
 document.getElementById('highlightContentAreaContainer'),
 document.getElementById('highlightViewer'),
 { next: () => nextHighlightSlide(), prev: () => prevHighlightSlide(), close: () => closeHighlightViewer() }
);

/* ---- Borrar destacadas ---- */
function openHighlightManageSheet() {
 if (!currentHighlightObj) return;
 const canDeletePhoto = currentHighlightItemIds.length > 1;
 const photoBtn = document.getElementById('highlightDeletePhotoBtn');
 if (photoBtn) photoBtn.style.display = currentHighlightItemIds.length > 0 ? 'block' : 'none';
 if (photoBtn) photoBtn.textContent = canDeletePhoto ? 'Eliminar esta foto' : 'Eliminar esta foto (se borra la destacada)';
 document.getElementById('highlightViewer').classList.add('is-menu-open');
 document.getElementById('highlightManageSheet').classList.add('active');
}

function closeHighlightManageSheet() {
 document.getElementById('highlightManageSheet')?.classList.remove('active');
 document.getElementById('highlightViewer')?.classList.remove('is-menu-open');
}

function refreshHighlightsAfterChange(userId) {
 delete highlightsCacheByUser[userId];
 ogCache.set('highlights_map', highlightsCacheByUser);
 const containerId = document.getElementById('highlightsScrollContainer') ? 'highlightsScrollContainer' : null;
 if (containerId) loadHighlights(userId, containerId);
}

/* Borra la destacada completa (con confirmación). Sirve desde el visor y desde el perfil. */
async function deleteHighlightById(highlight, { skipConfirm = false } = {}) {
 if (!currentUser || !highlight || highlight.user_id !== currentUser.id) return false;
 if (!skipConfirm && !confirm(`¿Eliminar la historia destacada "${highlight.title}"?`)) return false;

 // Primero las fotos (por si la base no las borra en cascada) y luego la destacada
 await db.from('highlight_items').delete().eq('highlight_id', highlight.id).eq('user_id', currentUser.id);
 const { error } = await db.from('highlights').delete().eq('id', highlight.id).eq('user_id', currentUser.id);
 if (error) {
  alert('No se pudo eliminar la destacada. Intentá de nuevo.');
  return false;
 }
 refreshHighlightsAfterChange(currentUser.id);
 return true;
}

async function deleteCurrentHighlight() {
 const hl = currentHighlightObj;
 closeHighlightManageSheet();
 if (!hl) return;
 const ok = await deleteHighlightById(hl);
 if (ok) closeHighlightViewer();
}

async function deleteCurrentHighlightPhoto() {
 const hl = currentHighlightObj;
 const idx = currentHighlightIndex;
 const itemId = currentHighlightItemIds[idx];
 closeHighlightManageSheet();
 if (!hl || !currentUser || hl.user_id !== currentUser.id) return;

 // Si es la única foto, se borra la destacada completa
 if (!itemId || currentHighlightItemIds.length <= 1) {
  const ok = await deleteHighlightById(hl);
  if (ok) closeHighlightViewer();
  return;
 }
 if (!confirm('¿Eliminar esta foto de la destacada?')) return;

 const removedUrl = currentHighlightItems[idx];
 const { error } = await db.from('highlight_items').delete().eq('id', itemId).eq('user_id', currentUser.id);
 if (error) {
  alert('No se pudo eliminar la foto. Intentá de nuevo.');
  return;
 }

 currentHighlightItems.splice(idx, 1);
 currentHighlightItemIds.splice(idx, 1);
 if (hl.items) hl.items = currentHighlightItems.slice();
 if (hl.itemIds) hl.itemIds = currentHighlightItemIds.slice();

 // Si la foto borrada era la portada, la portada pasa a ser la primera que queda
 if (hl.cover_url === removedUrl) {
  hl.cover_url = currentHighlightItems[0];
  await db.from('highlights').update({ cover_url: hl.cover_url }).eq('id', hl.id).eq('user_id', currentUser.id);
 }

 currentHighlightIndex = Math.min(idx, currentHighlightItems.length - 1);
 refreshHighlightsAfterChange(currentUser.id);
 renderCurrentHighlightItem();
}

function renderHighlightsListToDOM(highlights, userId, container) {
 const isOwner = currentUser && userId === currentUser.id;
 const profile = profilesCache[userId] || (isOwner ? myProfile : viewedProfile);
 const fragment = document.createDocumentFragment();

 if (isOwner) {
  const newDiv = document.createElement('div');
  newDiv.className = 'highlight-item';
  newDiv.onclick = () => createNewHighlightModal();
  newDiv.innerHTML = `<div class="highlight-circle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:24px;height:24px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div><span class="highlight-title">Nuevo</span>`;
  fragment.append(newDiv);
 }

 (highlights || []).forEach(h => {
  const item = document.createElement('div');
  item.className = 'highlight-item';
  item.onclick = () => openHighlightViewer(h, profile);

  if (isOwner) {
   // Mantener presionado (celular) o clic derecho (computadora) para eliminar
   let pressTimer = null;
   let longPressed = false;
   const cancelPress = () => clearTimeout(pressTimer);
   item.addEventListener('touchstart', () => {
    longPressed = false;
    pressTimer = setTimeout(() => {
     longPressed = true;
     if (navigator.vibrate) navigator.vibrate(15);
     deleteHighlightById(h);
    }, 600);
   }, { passive: true });
   item.addEventListener('touchmove', cancelPress, { passive: true });
   item.addEventListener('touchend', cancelPress, { passive: true });
   item.addEventListener('touchcancel', cancelPress, { passive: true });
   item.onclick = () => {
    if (longPressed) { longPressed = false; return; }
    openHighlightViewer(h, profile);
   };
   item.oncontextmenu = e => {
    e.preventDefault();
    deleteHighlightById(h);
   };
  }

  const circle = document.createElement('div');
  circle.className = 'highlight-circle';
  const coverSrc = h.cover_url || (h.items && h.items[0]) || '';
  if (coverSrc) {
   const img = document.createElement('img');
   img.src = coverSrc;
   img.loading = 'lazy';
   img.decoding = 'async';
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

async function loadHighlights(userId, containerId) {
 const container = document.getElementById(containerId);
 if (!container || !userId) return;

 let prevSig = null;
 if (Array.isArray(highlightsCacheByUser[userId])) {
  prevSig = JSON.stringify(highlightsCacheByUser[userId]);
  if (container.childElementCount === 0) renderHighlightsListToDOM(highlightsCacheByUser[userId], userId, container);
 }

 const highlights = await fetchUserHighlightsFromSupabase(userId);
 // Sin cambios y ya dibujado: no se redibuja
 if (prevSig !== null && container.childElementCount > 0 && prevSig === JSON.stringify(highlights)) return;
 renderHighlightsListToDOM(highlights, userId, container);
}
