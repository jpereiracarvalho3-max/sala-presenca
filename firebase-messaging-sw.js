/* Recebe as notificações do app Eventos dos Bêbados (Firebase Cloud Messaging).
   Mostra SEMPRE a notificação, mesmo com o app aberto na tela: o iPhone cancela o cadastro do aparelho
   quando chegam avisos que não viram notificação, e o Firebase sozinho não mostra nada com o app aberto.
   Por isso este arquivo trata o aviso antes do Firebase (registrado primeiro) e não deixa o Firebase tratar de novo. */
const BASE = self.registration.scope;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  e.stopImmediatePropagation();
  let p = {};
  try { p = e.data.json() || {}; } catch (x) {}
  const n = p.notification || {};
  const op = { body: n.body || '', icon: n.icon || BASE + 'icone-192.png', badge: n.badge || BASE + 'icone-192.png',
    data: { link: (p.fcmOptions && p.fcmOptions.link) || n.click_action || BASE } };
  if (n.tag) op.tag = n.tag;
  e.waitUntil(self.registration.showNotification(n.title || 'Eventos dos Bêbados', op));
});
self.addEventListener('notificationclick', (e) => {
  e.stopImmediatePropagation();
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || BASE;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const c = cs.find((x) => x.url.indexOf(BASE) === 0 && 'focus' in x);
    return c ? c.focus() : self.clients.openWindow(link);
  }));
});
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
firebase.initializeApp({apiKey:"AIzaSyD8bO9UARwmwFzoAHe03_AV3iLQMPR9sAI",authDomain:"sala-presenca.firebaseapp.com",projectId:"sala-presenca",storageBucket:"sala-presenca.firebasestorage.app",messagingSenderId:"41549125231",appId:"1:41549125231:web:1be6dbefa5d5b47b79df9a"});
firebase.messaging();
