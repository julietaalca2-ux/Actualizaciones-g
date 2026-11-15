/* Depende de: state.js (currentUser, touchStartX, touchStartY, touchEndX, touchEndY,
   isSwipeLocked, swipeNavigationFlow); core/pwa.js (updatePwaInstallButtonsVisibility)
   En tiempo de ejecución usa funciones de features/: loadMorePosts, showAuthOverlay,
   openCameraModal, loadActivity, loadExploreGrid, resetExploreSearch, loadConversations,
   loadMyPostsGrid, loadSavedPostsProfileGrid, loadHighlights, loadMenuPreferences,
   loadUserOwnActivity, loadSavedPostsGrid, populateAccountCenter
   Expone: isAnyModalOrSubViewOpen, applySwipeEntranceAnimation, handleSwipeGesture,
   showTab, openMenuSection, closeMenuSection, openMenuSubPage, backToMainMenu
   Registra: scroll infinito del feed y gestos swipe */
window.addEventListener('scroll', () => {
 if (!document.getElementById('feed').classList.contains('active')) return;
 if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 300) {
  loadMorePosts();
 }
}, { passive: true });

function isAnyModalOrSubViewOpen() {
 const modalIds = ['postDetailModal', 'editProfileModal', 'storyViewer', 'cameraModal', 'logoutConfirmModal', 'highlightModal', 'highlightViewer', 'addToHighlightModal', 'iosInstallModal'];
 for (const id of modalIds) {
  const el = document.getElementById(id);
  if (el && el.classList.contains('active')) return true;
 }
 const followModal = document.getElementById('followListModal');
 if (followModal && followModal.classList.contains('open')) return true;
 const authOverlay = document.getElementById('authWelcomeOverlay');
 if (authOverlay && authOverlay.classList.contains('visible')) return true;
 return false;
}

function applySwipeEntranceAnimation(targetTabId, direction) {
 const targetEl = document.getElementById(targetTabId);
 if (!targetEl) return;
 targetEl.classList.remove('swipe-enter-right', 'swipe-enter-left');
 void targetEl.offsetWidth;
 targetEl.classList.add(direction === 'left' ? 'swipe-enter-right' : 'swipe-enter-left');
 setTimeout(() => {
  targetEl.classList.remove('swipe-enter-right', 'swipe-enter-left');
 }, 280);
}

function handleSwipeGesture() {
 if (isSwipeLocked || isAnyModalOrSubViewOpen()) return;
 const swipeDistanceX = touchEndX - touchStartX;
 const swipeDistanceY = Math.abs(touchEndY - touchStartY);
 if (swipeDistanceY > Math.abs(swipeDistanceX) * 0.85) return;
 if (Math.abs(swipeDistanceX) < 55) return;

 const currentActiveTab = document.querySelector('main > div.active');
 if (!currentActiveTab) return;

 const currentId = currentActiveTab.id;
 const currentIndex = swipeNavigationFlow.indexOf(currentId);
 if (currentIndex === -1) return;

 isSwipeLocked = true;
 setTimeout(() => { isSwipeLocked = false; }, 300);

 if (swipeDistanceX > 70 && currentIndex === 0) {
  openCameraModal();
  return;
 }

 let nextIndex = currentIndex;
 let direction = null;

 if (swipeDistanceX < -55 && currentIndex < swipeNavigationFlow.length - 1) {
  nextIndex = currentIndex + 1;
  direction = 'left';
 } else if (swipeDistanceX > 55 && currentIndex > 0) {
  nextIndex = currentIndex - 1;
  direction = 'right';
 }

 if (nextIndex !== currentIndex) {
  const targetTabId = swipeNavigationFlow[nextIndex];
  const navButtons = document.querySelectorAll('#bottomNavBar button');
  showTab(targetTabId, navButtons[nextIndex]);
  applySwipeEntranceAnimation(targetTabId, direction);
 }
}

const mainContainerElement = document.querySelector('main');
mainContainerElement.addEventListener('touchstart', e => {
 if (e.target.closest('.stories, input, textarea, select, [data-no-swipe]')) {
  touchStartX = 0;
  return;
 }
 touchStartX = e.changedTouches[0].clientX;
 touchStartY = e.changedTouches[0].clientY;
}, { passive: true });

mainContainerElement.addEventListener('touchend', e => {
 if (touchStartX === 0) return;
 touchEndX = e.changedTouches[0].clientX;
 touchEndY = e.changedTouches[0].clientY;
 handleSwipeGesture();
 touchStartX = 0;
}, { passive: true });

function showTab(id, btn) {
 if (!currentUser && id !== 'profile') {
  showAuthOverlay();
  return;
 }

 document.querySelectorAll('main>div').forEach(x => x.classList.remove('active'));
 document.getElementById(id).classList.add('active');
 document.querySelectorAll('nav button').forEach(x => x.classList.remove('active'));

 if (btn) {
  btn.classList.add('active');
 } else {
  const tabIds = ['feed', 'messagesPage', 'explore', 'profile'];
  const index = tabIds.indexOf(id);
  if (index >= 0) document.querySelectorAll('nav button')[index].classList.add('active');
 }

 const defaultIcons = document.getElementById('header-default-icons');
 const profileIcons = document.getElementById('header-profile-icons');
 const headerPlusBtn = document.getElementById('headerPlusBtn');
 const headerLogoSlot = document.getElementById('headerLogoSlot');
 const bottomNavBar = document.getElementById('bottomNavBar');

 if (bottomNavBar) {
  bottomNavBar.style.display = 'flex';
  bottomNavBar.classList.remove('nav-hidden');
 }

 if (id === 'feed') {
  if (headerLogoSlot) headerLogoSlot.style.display = 'flex';
  if (headerPlusBtn) headerPlusBtn.style.display = 'none';
  if (defaultIcons) defaultIcons.style.display = 'flex';
  if (profileIcons) profileIcons.style.display = 'none';
 } else if (id === 'profile') {
  if (headerLogoSlot) headerLogoSlot.style.display = 'none';
  if (headerPlusBtn) headerPlusBtn.style.display = 'inline-flex';
  if (defaultIcons) defaultIcons.style.display = 'none';
  if (profileIcons) profileIcons.style.display = 'flex';
 } else {
  if (headerLogoSlot) headerLogoSlot.style.display = 'none';
  if (headerPlusBtn) headerPlusBtn.style.display = 'none';
  if (defaultIcons) defaultIcons.style.display = 'none';
  if (profileIcons) profileIcons.style.display = 'none';
 }

 updatePwaInstallButtonsVisibility();

 if (id === 'notifications') loadActivity();
 if (id === 'explore') {
  loadExploreGrid();
  if (!document.getElementById('search').value) resetExploreSearch();
 }
 if (id === 'messagesPage') loadConversations();
 if (id === 'profile' && currentUser) {
  loadMyPostsGrid();
  loadSavedPostsProfileGrid();
  loadHighlights(currentUser.id, 'highlightsScrollContainer');
 }
 window.scrollTo(0, 0);
}

function openMenuSection() {
 if (!currentUser) { showAuthOverlay(); return; }
 document.querySelectorAll('main>div').forEach(x => x.classList.remove('active'));
 document.getElementById('menuSectionPage').classList.add('active');

 const bottomNavBar = document.getElementById('bottomNavBar');
 if (bottomNavBar) bottomNavBar.style.display = 'none';

 document.getElementById('headerLogoSlot').style.display = 'none';
 document.getElementById('headerPlusBtn').style.display = 'none';
 document.getElementById('header-default-icons').style.display = 'none';
 document.getElementById('header-profile-icons').style.display = 'none';
 updatePwaInstallButtonsVisibility();
}

function closeMenuSection() {
 document.getElementById('menuSectionPage').classList.remove('active');
 showTab('profile');
}

function openMenuSubPage(pageId) {
 document.querySelectorAll('main>div').forEach(x => x.classList.remove('active'));
 document.getElementById(pageId).classList.add('active');
 loadMenuPreferences();

 if (pageId === 'menuActivityPage') loadUserOwnActivity();
 if (pageId === 'menuSavedPage') loadSavedPostsGrid();
 if (pageId === 'menuAccountsPage') populateAccountCenter();
}

function backToMainMenu(currentPageId) {
 document.getElementById(currentPageId).classList.remove('active');
 document.getElementById('menuSectionPage').classList.add('active');
}

