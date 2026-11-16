/* Depende de: config.js (db); state.js (currentUser); utils.js (status);
   core/realtime.js (setupPresenceChannel)
   Expone: MENU_PREFS_CONFIG, saveMenuPreferences, loadMenuPreferences,
   submitHelpReport, populateAccountCenter, updateUserPassword */
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
 { key: 'notifDm', id: 'notifDmToggle', defaultVal: true }
];

function saveMenuPreferences() {
 const prefs = {};
 MENU_PREFS_CONFIG.forEach(({ key, id, defaultVal }) => {
  const el = document.getElementById(id);
  prefs[key] = el ? el.checked : defaultVal;
 });
 localStorage.setItem('og_user_settings_' + (currentUser?.id || 'guest'), JSON.stringify(prefs));
 setupPresenceChannel();
}

function loadMenuPreferences() {
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
 refreshGoogleIdentityUI();
 document.getElementById('googleLinkStatus').textContent = '';
 document.getElementById('passwordStatus').textContent = '';
 document.getElementById('newPasswordInput').value = '';
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



// Vincula Google a la sesión Ög actual. No busca ni fusiona cuentas por correo.
function hasGoogleIdentity(user) {
 return !!user?.identities?.some(identity => identity.provider === 'google');
}

function refreshGoogleIdentityUI() {
 const statusEl = document.getElementById('googleIdentityStatus');
 const button = document.getElementById('googleLinkButton');
 if (!statusEl || !button) return;
 const linked = hasGoogleIdentity(currentUser);
 statusEl.textContent = linked ? 'Google ya está vinculado a esta cuenta de Ög.' : 'Todavía no vinculaste una cuenta de Google.';
 button.textContent = linked ? 'Cuenta de Google vinculada' : 'Vincular cuenta de Google';
 button.disabled = linked;
}

async function linkGoogleAccount() {
 const statusEl = document.getElementById('googleLinkStatus');
 if (!currentUser) {
  if (statusEl) statusEl.textContent = 'Iniciá sesión en Ög antes de vincular Google.';
  return;
 }
 if (hasGoogleIdentity(currentUser)) {
  refreshGoogleIdentityUI();
  if (statusEl) statusEl.textContent = 'Esta cuenta ya tiene Google vinculado.';
  return;
 }
 if (statusEl) statusEl.textContent = 'Redirigiendo a Google para autorizar la vinculación...';
 const redirectTo = window.location.origin + window.location.pathname;
 const { error } = await db.auth.linkIdentity({
  provider: 'google',
  options: { redirectTo }
 });
 if (error && statusEl) statusEl.textContent = 'No se pudo vincular Google: ' + error.message;
}
