/* Depende de: todos los módulos anteriores (config, state, utils, core/*, features/*)
   Se carga siempre al final. Solo inicializa la aplicación. */
async function init() {
 updatePwaInstallButtonsVisibility();
 const { data } = await db.auth.getSession();
 if (data.session?.user) {
  await loadAccount(data.session.user);
  hideSplashScreen();
 } else {
  hideSplashScreen();
  showAuthOverlay();
 }
}

db.auth.onAuthStateChange((event, session) => {
 if (event === 'SIGNED_IN' && session?.user && !currentUser) {
  loadAccount(session.user);
 } else if (event === 'SIGNED_OUT') {
  currentUser = null;
  showAuthOverlay();
 }
});

init();
