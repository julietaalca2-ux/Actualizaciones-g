# Pasos para activar todo

## 1. Música en publicaciones (obligatorio)
Supabase → SQL Editor → pega y ejecuta `supabase/01_musica_posts_y_push.sql`.
La música se elige de "Mis audios" o "Música libre" (Jamendo: pon tu Client ID en `js/features/audio-library.js`).

## 2. Notificaciones con la app abierta o en segundo plano
Ya funcionan sin configurar nada más: aviso arriba dentro de la app y notificación en el
centro de notificaciones del teléfono (la app debe seguir cargada en segundo plano).

## 3. Notificaciones con la app CERRADA (Web Push)
1. `npx web-push generate-vapid-keys`
2. Clave pública → `window.OG_VAPID_PUBLIC_KEY` en `js/config.js`.
3. Supabase CLI:
   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:tu@correo.com PUSH_WEBHOOK_SECRET=una-clave-larga
   supabase functions deploy send-push --no-verify-jwt
4. Supabase → Database → Webhooks: crea uno por tabla (messages, likes, comments, follows), evento INSERT,
   tipo Edge Function `send-push`, header `x-webhook-secret` = tu PUSH_WEBHOOK_SECRET.

## iPhone
Solo funciona con la app instalada ("Añadir a pantalla de inicio") en iOS 16.4 o superior.

---

# Cuenta privada, solicitudes y sonidos (v1.6.2)

## 4. Cuenta privada + solicitudes de seguidor (obligatorio para que funcione)
Supabase → SQL Editor → pega y ejecuta `supabase/02_cuenta_privada_y_solicitudes.sql`.
- Ajustes → Privacidad → "Cuenta privada" ahora se guarda en el servidor (`og_profiles.is_private`).
- Quien intente seguirte pasa a "Solicitado" y te aparece en Notificaciones → "Solicitudes de seguidores" (Confirmar / Eliminar).
- Si pasás la cuenta a pública, las solicitudes pendientes se aceptan solas.
- Seguir por la puerta de atrás está bloqueado con un trigger en `follows`.

## 5. Sonidos
No hay archivos de audio: se generan con Web Audio. Se pueden apagar en Ajustes → Notificaciones → "Sonidos de la app".
- Enviar mensaje · publicar · notificación con la app abierta · mensaje recibido con el chat abierto · aprobar solicitud.
- Con la app cerrada o en segundo plano el sonido lo pone el sistema del teléfono (la web no lo puede cambiar).
- En iPhone el audio se habilita tras el primer toque en la app.
