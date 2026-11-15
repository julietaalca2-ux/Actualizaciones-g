/* Depende de: nada (solo el DOM, en tiempo de ejecución)
   Expone: deferredInstallPrompt, isAppInStandaloneMode, isIosDevice,
   updatePwaInstallButtonsVisibility, triggerAndroidInstall,
   openIosInstallModal, closeIosInstallModal
   Registra: Service Worker, beforeinstallprompt, appinstalled */
let deferredInstallPrompt = null;

function isAppInStandaloneMode() {
 return (
  window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true ||
  document.referrer.includes('android-app://')
 );
}

function isIosDevice() {
 const ua = window.navigator.userAgent.toLowerCase();
 return /iphone|ipad|ipod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function updatePwaInstallButtonsVisibility() {
 const standalone = isAppInStandaloneMode();
 const canInstallAndroid = !standalone && !!deferredInstallPrompt;
 const canShowIosGuide = !standalone && isIosDevice();

 const androidBtnIds = ['authInstallAndroidBtn', 'headerInstallAndroidBtn', 'menuInstallAndroidBtn'];
 const iosBtnIds = ['authInstallIosBtn', 'headerInstallIosBtn', 'menuInstallIosBtn'];

 androidBtnIds.forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  if (id === 'headerInstallAndroidBtn') {
   const isFeedActive = document.getElementById('feed')?.classList.contains('active');
   el.style.display = (canInstallAndroid && isFeedActive) ? 'inline-flex' : 'none';
  } else {
   el.style.display = canInstallAndroid ? 'flex' : 'none';
  }
 });

 iosBtnIds.forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  if (id === 'headerInstallIosBtn') {
   const isFeedActive = document.getElementById('feed')?.classList.contains('active');
   el.style.display = (canShowIosGuide && isFeedActive) ? 'inline-flex' : 'none';
  } else {
   el.style.display = canShowIosGuide ? 'flex' : 'none';
  }
 });
}

window.addEventListener('beforeinstallprompt', event => {
 event.preventDefault();
 deferredInstallPrompt = event;
 updatePwaInstallButtonsVisibility();
});

window.addEventListener('appinstalled', () => {
 deferredInstallPrompt = null;
 updatePwaInstallButtonsVisibility();
});

async function triggerAndroidInstall() {
 if (!deferredInstallPrompt) return;
 deferredInstallPrompt.prompt();
 const { outcome } = await deferredInstallPrompt.userChoice;
 if (outcome === 'accepted') {
  deferredInstallPrompt = null;
 }
 updatePwaInstallButtonsVisibility();
}

function openIosInstallModal() {
 document.getElementById('iosInstallModal')?.classList.add('active');
}

function closeIosInstallModal() {
 document.getElementById('iosInstallModal')?.classList.remove('active');
}

if ('serviceWorker' in navigator) {
 window.addEventListener('load', async () => {
  try {
   const registration = await navigator.serviceWorker.register('./sw.js', {
    scope: './',
    updateViaCache: 'none'
   });

   registration.addEventListener('updatefound', () => {
    const newWorker = registration.installing;
    if (!newWorker) return;
    newWorker.addEventListener('statechange', () => {
     if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
      newWorker.postMessage({ type: 'SKIP_WAITING' });
     }
    });
   });

   let refreshing = false;
   navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
   });
  } catch (err) {}
 });
}

