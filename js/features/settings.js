/* Depende de: config.js (db); state.js (currentUser); utils.js (status);
   core/realtime.js (setupPresenceChannel)
   Expone: MENU_PREFS_CONFIG, saveMenuPreferences, loadMenuPreferences,
   submitHelpReport, populateAccountCenter, linkGoogleAccount, refreshGoogleLinkStatus, updateUserPassword,
   THEME_COLORS, getSavedTheme, applyTheme, setTheme, initTheme */

/* ---------- Temas (Automático · Blanco · Gris · Oscuro · Negro) ---------- */
const THEME_STORAGE_KEY = 'og_theme';
const THEME_COLORS = { light: '#fbf8fc', gray: '#e4e4e7', dark: '#121214', black: '#000000' };
const THEME_OPTIONS = ['auto', 'light', 'gray', 'dark', 'black'];

function getSavedTheme() {
 try {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  return THEME_OPTIONS.includes(saved) ? saved : 'light';
 } catch (e) {
  return 'light';
 }
}

function resolveTheme(pref) {
 if (pref !== 'auto') return pref;
 return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(pref) {
 const theme = resolveTheme(pref);
 const root = document.documentElement;
 root.classList.add('theme-switching');
 root.setAttribute('data-theme', theme);
 requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS.light);
 document.querySelectorAll('#themePicker .theme-option').forEach(btn => {
  const selected = btn.dataset.themeOpt === pref;
  btn.classList.toggle('active', selected);
  btn.setAttribute('aria-checked', selected ? 'true' : 'false');
 });
}

function setTheme(pref) {
 if (!THEME_OPTIONS.includes(pref)) return;
 try { localStorage.setItem(THEME_STORAGE_KEY, pref); } catch (e) {}
 applyTheme(pref);
}

function initTheme() {
 applyTheme(getSavedTheme());
 // En modo Automático, seguir los cambios del sistema en vivo
 if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => { if (getSavedTheme() === 'auto') applyTheme('auto'); };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
 }
}
const MENU_PREFS_CONFIG = [
 { key: 'dataSaver', id: 'cfgDataSaverToggle', defaultVal: false },
 { key: 'autoplay', id: 'cfgAutoplayToggle', defaultVal: true },
 { key: 'privateAccount', id: 'privateAccountToggle', defaultVal: false },
 { key: 'activityStatus', id: 'activityStatusToggle', defaultVal: true },
 { key: 'showFollowersList', id: 'showFollowersListToggle', defaultVal: true },
 { key: 'allowDm', id: 'allowDmToggle', defaultVal: true },
 { key: 'notifLikes', id: 'notifLikesToggle', defaultVal: true },
 { key: 'notifComments', id: 'notifCommentsToggle', defaultVal: true },
 { key: 'notifFollows', id: 'notifFollowsToggle', defaultVal: true },
 { key: 'notifDm', id: 'notifDmToggle', defaultVal: true },
 { key: 'soundEffects', id: 'soundEffectsToggle', defaultVal: true }
];

function saveMenuPreferences() {
 const prefs = {};
 MENU_PREFS_CONFIG.forEach(({ key, id, defaultVal }) => {
  const el = document.getElementById(id);
  prefs[key] = el ? el.checked : defaultVal;
 });
 localStorage.setItem('og_user_settings_' + (currentUser?.id || 'guest'), JSON.stringify(prefs));
 setupPresenceChannel();
 if (typeof ogSyncPushPrefs === 'function') ogSyncPushPrefs();
 if (typeof ogSyncPrivateAccount === 'function') ogSyncPrivateAccount();
}

function loadMenuPreferences() {
 if (typeof ogLoadPrivateFromServer === 'function') ogLoadPrivateFromServer(); // la cuenta privada vive en el servidor
 try {
  const raw = localStorage.getItem('og_user_settings_' + (currentUser?.id || 'guest'));
  if (!raw) return;
  const prefs = JSON.parse(raw);
  MENU_PREFS_CONFIG.forEach(({ key, id, defaultVal }) => {
   const el = document.getElementById(id);
   if (el) el.checked = defaultVal ? prefs[key] !== false : !!prefs[key];
  });
 } catch (e) {}
}

function submitHelpReport() {
 const val = document.getElementById('helpReportInput').value.trim();
 if (!val) return status('helpReportStatus', 'Escribí tu mensaje antes de enviar.');
 document.getElementById('helpReportInput').value = '';
 status('helpReportStatus', '¡Gracias! Tu mensaje fue enviado al soporte.');
 setTimeout(() => status('helpReportStatus', ''), 3500);
}

function populateAccountCenter() {
 if (!currentUser) return;
 document.getElementById('passwordStatus').textContent = '';
 document.getElementById('newPasswordInput').value = '';
 refreshGoogleLinkStatus();
}

/* ---------- Vinculación con Google (Centro de cuentas) ---------- */
async function getGoogleIdentity() {
 let identities = null;
 try {
  const { data, error } = await db.auth.getUserIdentities();
  if (!error && data) identities = data.identities;
 } catch (e) { /* versión vieja de supabase-js: se usa getUser() */ }
 if (!identities) {
  const { data } = await db.auth.getUser();
  identities = (data && data.user && data.user.identities) || [];
 }
 return identities.find(i => i.provider === 'google') || null;
}

async function refreshGoogleLinkStatus() {
 const statusEl = document.getElementById('googleIdentityStatus');
 const btn = document.getElementById('googleLinkButton');
 const txt = document.getElementById('googleLinkButtonText');
 if (!statusEl || !btn || !txt) return;
 statusEl.textContent = 'Comprobando estado...';
 try {
  const google = await getGoogleIdentity();
  if (google) {
   const email = google.identity_data && google.identity_data.email;
   statusEl.textContent = email ? 'Vinculada: ' + email : 'Tu cuenta de Google está vinculada.';
   txt.textContent = 'Cuenta de Google vinculada';
   btn.disabled = true;
   btn.classList.add('linked');
  } else {
   statusEl.textContent = 'No vinculada. Vinculala para entrar a esta misma cuenta con Google.';
   txt.textContent = 'Vincular cuenta de Google';
   btn.disabled = false;
   btn.classList.remove('linked');
  }
 } catch (e) {
  statusEl.textContent = 'No se pudo comprobar el estado.';
  txt.textContent = 'Vincular cuenta de Google';
  btn.disabled = false;
 }
}

async function linkGoogleAccount() {
 status('googleLinkStatus', 'Conectando con Google...');
 const redirectTo = window.location.origin + window.location.pathname;
 const { error } = await db.auth.linkIdentity({ provider: 'google', options: { redirectTo } });
 if (error) {
  const manualOff = /manual.?linking/i.test(error.message || '');
  status('googleLinkStatus', manualOff
   ? 'La vinculación manual está desactivada en Supabase (Authentication → Sign In / Providers → Allow manual linking).'
   : 'No se pudo vincular: ' + error.message);
 }
}

async function updateUserPassword() {
 const newPassword = document.getElementById('newPasswordInput').value;
 if (!newPassword || newPassword.length < 8) {
  return status('passwordStatus', 'La contraseña debe tener al menos 8 caracteres.');
 }
 status('passwordStatus', 'Actualizando contraseña...');
 const { error } = await db.auth.updateUser({ password: newPassword });
 if (error) return status('passwordStatus', 'Error: ' + error.message);

 document.getElementById('newPasswordInput').value = '';
 status('passwordStatus', '¡Contraseña actualizada correctamente!');
}

