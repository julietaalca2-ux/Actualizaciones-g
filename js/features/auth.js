/* Depende de: config.js (db); state.js (currentUser, myProfile, viewedProfile, profilesCache,
   myActiveStories, storiesByUserMap, highlightsCacheByUser, cachedConversationsList,
   cachedActivityEvents, cachedFeedPosts, loadedPostIds, realtimeChannel, dmRealtimeChannel,
   postsRealtimeChannel, presenceChannel); utils.js (status, updateNavAvatarUI);
   core/pwa.js (updatePwaInstallButtonsVisibility); core/navigation.js (showTab);
   core/realtime.js (setupRealtimeNotifications, setupPresenceChannel)
   En tiempo de ejecución usa funciones de features/: updateProfileUI, loadInitialPosts,
   loadStoriesData, loadHighlights, checkGlobalUnreadMessages, updateStoryUI
   Expone: switchAuthSubView, showAuthOverlay, hideAuthOverlay, hideSplashScreen,
   signInWithGoogle, signInWithFacebook, executeSignUp, executeSignIn, loadAccount,
   promptLogoutConfirmation, closeLogoutConfirmation, executeConfirmedSignOut */

let loadingAccountUserId = null;

function switchAuthSubView(viewName) {
 document.getElementById('authWelcomePanel').classList.remove('active');
 document.getElementById('authSignupPanel').classList.remove('active');
 document.getElementById('authSigninPanel').classList.remove('active');
 document.getElementById('authOverlayStatus').textContent = '';

 if (viewName === 'welcome') document.getElementById('authWelcomePanel').classList.add('active');
 if (viewName === 'signup') document.getElementById('authSignupPanel').classList.add('active');
 if (viewName === 'signin') document.getElementById('authSigninPanel').classList.add('active');
}

function showAuthOverlay() {
 document.getElementById('authWelcomeOverlay').classList.add('visible');
 updatePwaInstallButtonsVisibility();
}

function hideAuthOverlay() {
 document.getElementById('authWelcomeOverlay').classList.remove('visible');
}

function hideSplashScreen() {
 const splash = document.getElementById('appSplashScreen');
 if (splash) {
  splash.classList.add('fade-out');
  setTimeout(() => splash.remove(), 300);
 }
}

// Acceso con Google: Supabase administra el flujo OAuth y la sesión.
async function signInWithGoogle() {
 status('authOverlayStatus', 'Conectando con Google...');
 const redirectTo = window.location.origin + window.location.pathname;
 const { error } = await db.auth.signInWithOAuth({
  provider: 'google',
  options: { redirectTo }
 });
 if (error) status('authOverlayStatus', 'No se pudo iniciar con Google: ' + error.message);
}

// Acceso con Facebook: Supabase administra el flujo OAuth y la sesión.
async function signInWithFacebook() {
 status('authOverlayStatus', 'Conectando con Facebook...');
 const redirectTo = window.location.pathname && window.location.pathname !== '/'
  ? window.location.origin + window.location.pathname
  : window.location.origin;

 const { data, error } = await db.auth.signInWithOAuth({
  provider: 'facebook',
  options: {
   redirectTo
  }
 });

 if (error) {
  console.error('ÖG - Error en Facebook OAuth:', error);
  status('authOverlayStatus', 'No se pudo iniciar con Facebook: ' + error.message);
 }
}

async function executeSignUp() {
 const email = document.getElementById('regEmail').value.trim();
 const password = document.getElementById('regPassword').value;
 const username = document.getElementById('regUsername').value.trim().toLowerCase();

 if (!email || !password || !username) return status('authOverlayStatus', 'Completá todos los campos.');
 if (!/^[a-z0-9_]{3,20}$/.test(username)) return status('authOverlayStatus', 'Usuario: 3 a 20 caracteres alfanuméricos.');
 if (password.length < 8) return status('authOverlayStatus', 'Contraseña mínima de 8 caracteres.');

 status('authOverlayStatus', 'Creando cuenta...');
 const { data, error } = await db.auth.signUp({
  email,
  password,
  options: { data: { username } }
 });

 if (error) return status('authOverlayStatus', error.message);

 if (data.session) {
  await loadAccount(data.user);
  hideAuthOverlay();
 } else {
  status('authOverlayStatus', '¡Cuenta creada! Ya podés iniciar sesión.');
  setTimeout(() => switchAuthSubView('signin'), 1500);
 }
}

async function executeSignIn() {
 const email = document.getElementById('loginEmail').value.trim();
 const password = document.getElementById('loginPassword').value;

 if (!email || !password) return status('authOverlayStatus', 'Ingresá correo y contraseña.');

 status('authOverlayStatus', 'Iniciando sesión...');
 const { data, error } = await db.auth.signInWithPassword({ email, password });

 if (error) return status('authOverlayStatus', error.message);

 await loadAccount(data.user);
 hideAuthOverlay();
}

async function loadAccount(user) {
 if (!user) return;
 if (loadingAccountUserId === user.id) return;
 loadingAccountUserId = user.id;

 try {
  currentUser = user;

  let { data: profile, error } = await db
   .from('og_profiles')
   .select('*')
   .eq('id', user.id)
   .maybeSingle();

  if (error) {
   console.error('ÖG - Error cargando perfil:', error);
   alert('No se pudo cargar tu perfil: ' + error.message);
   return;
  }

  if (!profile) {
   const baseUsername = user.user_metadata?.username || ('usuario_' + user.id.slice(0, 8));
   const displayName = user.user_metadata?.full_name || user.user_metadata?.name || baseUsername;

   let candidateUsername = baseUsername;
   let created = null;
   let createError = null;

   for (let attempt = 0; attempt < 5; attempt++) {
    const res = await db
     .from('og_profiles')
     .upsert(
      {
       id: user.id,
       username: candidateUsername,
       display_name: displayName
      },
      { onConflict: 'id' }
     )
     .select()
     .single();

    created = res.data;
    createError = res.error;

    if (!createError || createError.code !== '23505') break;

    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    candidateUsername = 'usuario_' + user.id.slice(0, 6) + '_' + randomSuffix;
   }

   if (createError) {
    console.error('ÖG - Error creando perfil:', createError);
    alert('No se pudo crear tu perfil: ' + createError.message);
    return;
   }

   profile = created;
  }

  myProfile = profile;
  profilesCache[user.id] = profile;

  hideAuthOverlay();
  updateProfileUI();
  updateNavAvatarUI();
  updatePwaInstallButtonsVisibility();

  await Promise.all([
   loadInitialPosts(),
   loadStoriesData(),
   loadHighlights(user.id, 'highlightsScrollContainer'),
   checkGlobalUnreadMessages()
  ]);

  setupRealtimeNotifications();
  setupPresenceChannel();
 } finally {
  loadingAccountUserId = null;
 }
}

function promptLogoutConfirmation() {
 document.getElementById('logoutConfirmModal').classList.add('active');
}

function closeLogoutConfirmation() {
 document.getElementById('logoutConfirmModal').classList.remove('active');
}

async function executeConfirmedSignOut() {
 closeLogoutConfirmation();

 const { error } = await db.auth.signOut();
 if (error) return alert(error.message);

 if (realtimeChannel) db.removeChannel(realtimeChannel);
 if (dmRealtimeChannel) db.removeChannel(dmRealtimeChannel);
 if (postsRealtimeChannel) db.removeChannel(postsRealtimeChannel);
 if (presenceChannel) db.removeChannel(presenceChannel);

 currentUser = null;
 myProfile = null;
 viewedProfile = null;
 myActiveStories = [];
 storiesByUserMap = {};
 highlightsCacheByUser = {};
 cachedConversationsList = null;
 cachedActivityEvents = null;
 cachedFeedPosts = null;
 loadedPostIds.clear();

 updateStoryUI();
 updateNavAvatarUI();
 updateProfileUI();
 showAuthOverlay();
 showTab('feed');
}
