// Service worker: funcionamiento sin conexión + notificaciones push.
const CACHE = 'hidra-v4';
const CFG_CACHE = 'hidra-cfg';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/badge-96.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== CFG_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Apps Script: siempre red
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(url.pathname.endsWith('/') ? './' : e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./')))
  );
});

/* ---------- Utilidades ---------- */
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmt = (n) => Number(n).toLocaleString('es-ES');

async function getCfg() {
  try {
    const r = await (await caches.open(CFG_CACHE)).match('cfg');
    return r ? await r.json() : null;
  } catch { return null; }
}
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}
async function todayTotal(cfg) {
  const sep = cfg.url.includes('?') ? '&' : '?';
  const res = await withTimeout(fetch(`${cfg.url}${sep}action=hoy&date=${dayKey(new Date())}&token=${encodeURIComponent(cfg.token)}`), 6000);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data.total;
}
const NOTIF_BASE = { icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: 'hidra', lang: 'es' };
const ACTIONS = [{ action: 'beber', title: '+ Medio vaso' }, { action: 'ver', title: 'Ver vaso' }];

/* ---------- Push: recordatorio ---------- */
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    const cfg = await getCfg();
    const goal = cfg?.goal || 2000, sip = cfg?.sip || 125;
    let body = `Toca «+ Medio vaso» para apuntar ${sip} ml.`;
    try {
      if (cfg?.url) {
        const total = await todayTotal(cfg);
        const left = Math.max(0, goal - total);
        body = `Llevas ${fmt(total)} de ${fmt(goal)} ml. Te faltan unos ${Math.ceil(left / sip)} medios vasos.`;
      }
    } catch {}
    await self.registration.showNotification('💧 Hora de beber agua', {
      ...NOTIF_BASE, body, renotify: true, requireInteraction: false, actions: ACTIONS, data: { kind: 'reminder' },
    });
  })());
});

/* ---------- Clic en la notificación ---------- */
async function openApp(path) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const url = new URL(path, self.registration.scope).href;
  for (const c of all) {
    if ('focus' in c) {
      await c.focus();
      c.postMessage({ type: 'launch', url });
      return;
    }
  }
  await self.clients.openWindow(url);
}

async function addFromNotification() {
  const cfg = await getCfg();
  if (!cfg?.url || !cfg?.token) return openApp('./?beber=1');
  const now = new Date();
  const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), ts: now.toISOString(), date: dayKey(now), ml: cfg.sip || 125 };
  try {
    const res = await withTimeout(fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: cfg.token, ops: [{ type: 'add', entry }], date: entry.date }),
    }), 10000);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    const goal = cfg.goal || 2000;
    await self.registration.showNotification(data.total >= goal ? '🎉 ¡Objetivo cumplido!' : `✅ +${entry.ml} ml apuntados`, {
      ...NOTIF_BASE, body: `Llevas ${fmt(data.total)} de ${fmt(goal)} ml hoy.`, silent: true, renotify: false,
      actions: [{ action: 'beber', title: '+ Otro medio vaso' }], data: { kind: 'done' },
    });
    // Avisa a la app abierta para que se sincronice
    (await self.clients.matchAll({ type: 'window' })).forEach((c) => c.postMessage({ type: 'sync' }));
  } catch {
    await openApp('./?beber=1'); // sin conexión: lo apunta la app y lo sincroniza después
  }
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.action === 'beber') e.waitUntil(addFromNotification());
  else e.waitUntil(openApp('./?ver=hoy'));
});

/* ---------- Guardado delegado (la app se va a segundo plano justo después) ---------- */
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'save') return;
  e.waitUntil((async () => {
    const cfg = await getCfg();
    if (!cfg?.url || !cfg?.token) return;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await withTimeout(fetch(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ token: cfg.token, ops: e.data.ops }),
        }), 15000);
        if ((await res.json()).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
  })());
});
