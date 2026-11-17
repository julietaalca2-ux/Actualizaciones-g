/* ==========================================
   APP.JS - ÖG (PWA Social Network)
   ========================================== */

async function init() {
  initTheme();
  updatePwaInstallButtonsVisibility();
  
  // Inicializar LOORS de forma segura si la función existe
  try {
    if (typeof initLoors === 'function') {
      initLoors();
    }
  } catch (err) {
    console.error('Error al inicializar Loors:', err);
  }

  try {
    const { data } = await db.auth.getSession();
    if (data.session?.user) {
      await loadAccount(data.session.user);
      hideSplashScreen();
    } else {
      hideSplashScreen();
      showAuthOverlay();
    }
  } catch (err) {
    // Sin red o error al cargar: nunca dejar la pantalla de carga congelada
    console.error('Error al iniciar la app:', err);
    hideSplashScreen();
    if (!currentUser) showAuthOverlay();
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

// Pausar videos de LOORS al cambiar a otras secciones de la barra inferior
document.addEventListener('DOMContentLoaded', () => {
  const otherNavButtons = document.querySelectorAll('#bottomNavBar button:not(#nav-loors-btn)');
  otherNavButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (typeof closeLoorsSection === 'function') {
        closeLoorsSection();
      }
    });
  });
});

init();
