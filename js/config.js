/* Depende de: CDN de Supabase (window.supabase)
   Expone: SUPABASE_URL, SUPABASE_KEY, db */
const SUPABASE_URL = "https://axxafvggyetnnaumqefi.supabase.co";
const SUPABASE_KEY = "sb_publishable_O4wRZft0LCo3DYiCWT4iqg_E5_c8B2A";
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
 auth: {
  persistSession: true,
  autoRefreshToken: true,
  detectSessionInUrl: true,
  storage: window.localStorage
 }
});

/* Notificaciones push (aviso aunque la app esté cerrada).
   Clave PÚBLICA VAPID: se genera una sola vez con  npx web-push generate-vapid-keys
   (la privada va como secret en la Edge Function send-push, nunca aquí). */
window.OG_VAPID_PUBLIC_KEY = 'BDI9nz6SLa9wU4UBATWFE1XP3dHsY_NHthnsq_nx1z1SzmMA_E_UHIGFaiCmvkguD_xgU0YwyH-g_mwvTedQRY0';
