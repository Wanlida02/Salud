'use strict';

/* ---------- Almacenamiento local ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const DEFAULTS = { goal: 2000, sip: 125, url: '', token: '', autoClose: true };
const REMIND_MS = 2 * 60 * 60 * 1000; // 2 h
const REMIND_FROM = 9, REMIND_TO = 21;

let cfg = { ...DEFAULTS, ...store.get('hidra.cfg', {}) };
let entries = store.get('hidra.entries', []);   // {id, ts, date, ml}
let queue = store.get('hidra.queue', []);       // {type:'add', entry} | {type:'del', id}
let sending = [];

const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => dayKey(new Date());
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtMl = (ml) => ml.toLocaleString('es-ES');
const parseDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };

function save() {
  store.set('hidra.entries', entries);
  store.set('hidra.queue', queue);
}
function totalsByDay() {
  const t = {};
  for (const e of entries) t[e.date] = (t[e.date] || 0) + e.ml;
  return t;
}

/* ---------- Acciones ---------- */
function add(ml = cfg.sip) {
  const now = new Date();
  const e = { id: uid(), ts: now.toISOString(), date: dayKey(now), ml: Number(ml) };
  entries.push(e);
  queue.push({ type: 'add', entry: e });
  save();
  if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate(30);
  render();
  toast(`+${fmtMl(e.ml)} ml · ${fmtMl(totalsByDay()[e.date])} de ${fmtMl(cfg.goal)}`, () => remove(e.id));
  scheduleSync();
}

function remove(id) {
  entries = entries.filter((e) => e.id !== id);
  const op = queue.find((q) => q.type === 'add' && q.entry.id === id);
  if (op && !sending.includes(op)) queue = queue.filter((q) => q !== op);
  else queue.push({ type: 'del', id });
  save();
  render();
  scheduleSync();
}

/* ---------- Sincronización (Google Apps Script) ---------- */
let syncing = false, syncAgain = false, syncTimer = null;
function scheduleSync(delay = 600) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}
function setSync(state, msg) {
  const b = $('#syncBadge');
  b.dataset.state = state;
  b.textContent = { off: 'Solo local', busy: 'Sincronizando…', ok: 'Sincronizado', err: 'Sin conexión' }[state];
  b.title = msg || b.textContent;
  if (state === 'err' && queue.length) b.textContent = `${queue.length} pendiente${queue.length > 1 ? 's' : ''}`;
}

async function sync() {
  if (!cfg.url || !cfg.token) { setSync('off'); return false; }
  if (syncing) { syncAgain = true; return false; }
  syncing = true;
  setSync('busy');
  sending = queue.slice();
  let ok = false;
  try {
    let res;
    if (sending.length) {
      // text/plain => petición "simple", sin preflight CORS
      res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token: cfg.token, ops: sending }),
      });
    } else {
      const sep = cfg.url.includes('?') ? '&' : '?';
      res = await fetch(`${cfg.url}${sep}token=${encodeURIComponent(cfg.token)}`);
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Respuesta no válida');

    queue = queue.filter((op) => !sending.includes(op));
    const pendingDel = new Set(queue.filter((o) => o.type === 'del').map((o) => o.id));
    const map = new Map();
    for (const e of data.entries) if (!pendingDel.has(e.id)) map.set(e.id, { ...e, ml: Number(e.ml) });
    for (const o of queue) if (o.type === 'add') map.set(o.entry.id, o.entry);
    entries = [...map.values()].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    save();
    setSync('ok');
    ok = true;
  } catch (err) {
    setSync('err', String(err.message || err));
  } finally {
    sending = [];
    syncing = false;
    render();
    if (syncAgain) { syncAgain = false; scheduleSync(100); }
  }
  return ok;
}

/* ---------- Vista: Hoy ---------- */
const GLASS_TOP = 18, GLASS_BOTTOM = 254;
function buildTicks() {
  const g = $('#ticks');
  const steps = Math.max(1, Math.round(cfg.goal / 250)); // marca cada vaso (250 ml)
  let html = '';
  for (let i = 1; i < steps; i++) {
    const y = GLASS_BOTTOM - (i / steps) * (GLASS_BOTTOM - GLASS_TOP);
    const xRight = 172 - ((y - GLASS_TOP) / (GLASS_BOTTOM - GLASS_TOP)) * 19;
    html += `<line x1="${xRight - 12}" y1="${y}" x2="${xRight - 3}" y2="${y}"/>`;
  }
  g.innerHTML = html;
}

function renderToday() {
  const today = todayKey();
  const list = entries.filter((e) => e.date === today);
  const total = list.reduce((s, e) => s + e.ml, 0);
  const p = Math.min(1, total / cfg.goal);
  const y = GLASS_BOTTOM - p * (GLASS_BOTTOM - GLASS_TOP) - (p > 0 ? 8 : 0);
  $('#water').style.transform = `translateY(${y}px)`;
  $('#mlToday').textContent = fmtMl(total);
  $('#pctToday').textContent = `${Math.round((total / cfg.goal) * 100)} % de ${fmtMl(cfg.goal)} ml`;
  $('.glass-wrap').classList.toggle('done', total >= cfg.goal);
  $('#sipLabel').textContent = `${cfg.sip} ml`;

  const left = cfg.goal - total;
  $('#statusLine').textContent = left > 0
    ? `Te faltan ${fmtMl(left)} ml · unos ${Math.ceil(left / cfg.sip)} medios vasos`
    : '¡Objetivo cumplido! 🎉';

  // Recordatorio dentro de la app
  const last = entries.length ? new Date(entries[entries.length - 1].ts) : null;
  const h = new Date().getHours();
  const since = last ? Date.now() - last.getTime() : Infinity;
  const showRem = left > 0 && h >= REMIND_FROM && h < REMIND_TO && since >= REMIND_MS;
  const rem = $('#reminder');
  rem.hidden = !showRem;
  if (showRem) {
    rem.textContent = last && since < 24 * 3600e3
      ? `⏰ Hace ${Math.floor(since / 3600e3)} h ${Math.floor((since % 3600e3) / 60e3)} min que no bebes`
      : '⏰ Aún no has bebido hoy';
  }

  const ul = $('#todayList');
  ul.innerHTML = list.length
    ? list.slice().reverse().map((e) => {
        const t = new Date(e.ts);
        return `<li><span>${pad(t.getHours())}:${pad(t.getMinutes())}</span><strong>${fmtMl(e.ml)} ml</strong>
          <button class="del" data-del="${e.id}" aria-label="Borrar registro de ${e.ml} ml">×</button></li>`;
      }).join('')
    : '<li class="empty">Todavía nada. ¡Empieza con medio vaso!</li>';
}

/* ---------- Vista: Historial ---------- */
function renderHistory() {
  const totals = totalsByDay();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const k = dayKey(d);
    days.push({ k, d, ml: totals[k] || 0 });
  }

  // Racha: días consecutivos cumpliendo objetivo (hoy cuenta si ya se cumplió)
  let streak = 0;
  const cur = new Date(today);
  if ((totals[dayKey(cur)] || 0) < cfg.goal) cur.setDate(cur.getDate() - 1);
  while ((totals[dayKey(cur)] || 0) >= cfg.goal) { streak++; cur.setDate(cur.getDate() - 1); }

  const past = days.slice(0, -1).filter((x) => x.ml > 0);
  const avg = past.length ? Math.round(past.reduce((s, x) => s + x.ml, 0) / past.length) : 0;
  $('#stStreak').textContent = streak;
  $('#stAvg').textContent = fmtMl(avg);
  $('#stHit').textContent = `${days.filter((x) => x.ml >= cfg.goal).length}/30`;

  // Gráfico
  const svg = $('#chart');
  const W = 300, H = 170, padL = 4, padB = 18, padT = 8;
  const max = Math.max(cfg.goal * 1.25, ...days.map((x) => x.ml));
  const bw = (W - padL * 2) / days.length;
  const yOf = (v) => H - padB - (v / max) * (H - padB - padT);
  let s = '';
  days.forEach((x, i) => {
    const y = yOf(x.ml);
    const cls = ['bar', x.ml >= cfg.goal ? 'hit' : '', i === days.length - 1 ? 'today' : ''].join(' ');
    s += `<rect class="${cls}" x="${padL + i * bw + 1}" y="${y}" width="${bw - 2}" height="${Math.max(0, H - padB - y)}" rx="2"><title>${x.d.toLocaleDateString('es-ES')}: ${x.ml} ml</title></rect>`;
    if (x.d.getDay() === 1 || i === days.length - 1)
      s += `<text x="${padL + i * bw + bw / 2}" y="${H - 5}" text-anchor="middle">${x.d.getDate()}</text>`;
  });
  s += `<line class="goal" x1="0" x2="${W}" y1="${yOf(cfg.goal)}" y2="${yOf(cfg.goal)}"/>`;
  s += `<text x="${W - 2}" y="${yOf(cfg.goal) - 3}" text-anchor="end">${cfg.goal / 1000} L</text>`;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = s;

  // Lista por día (todos los días con datos)
  const keys = Object.keys(totals).sort().reverse();
  $('#dayList').innerHTML = keys.length
    ? keys.map((k) => {
        const ml = totals[k];
        const pct = Math.min(100, Math.round((ml / cfg.goal) * 100));
        const label = parseDay(k).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
        return `<li class="${ml >= cfg.goal ? 'hit' : ''}"><span class="d">${label}</span>
          <span class="meter"><i style="width:${pct}%"></i></span><span class="v">${fmtMl(ml)} ml</span></li>`;
      }).join('')
    : '<li class="empty">Sin registros todavía</li>';
}

/* ---------- Vista: Ajustes ---------- */
function fillForm() {
  const f = $('#cfgForm');
  for (const k of ['goal', 'sip', 'url', 'token']) f.elements[k].value = cfg[k];
  f.elements.autoClose.checked = cfg.autoClose !== false;
}

/* ---------- Navegación ---------- */
const TITLES = { hoy: 'Hoy', historial: 'Historial', ajustes: 'Ajustes' };
let view = 'hoy';
function show(v) {
  view = TITLES[v] ? v : 'hoy';
  for (const k of Object.keys(TITLES)) $(`#view-${k}`).hidden = k !== view;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#title').textContent = TITLES[view];
  if (view === 'ajustes') { fillForm(); renderNotif(); }
  render();
}
function render() {
  if (view === 'hoy') renderToday();
  else if (view === 'historial') renderHistory();
}

/* ---------- Toast con deshacer ---------- */
let toastTimer, toastUndo;
function toast(msg, undo) {
  $('#toastMsg').textContent = msg;
  toastUndo = undo;
  $('#toastUndo').hidden = !undo;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}

/* ---------- Lanzamiento desde el icono ---------- */
// El icono abre "./?beber=1" → suma medio vaso. Mantener pulsado → acceso "Progreso e historial".
function handleLaunchUrl(href) {
  const u = new URL(href, location.href);
  const v = u.searchParams.get('ver');
  if (v) show(v);
  else if (u.searchParams.has('beber')) quickAdd();
}

/* ---------- Toque en el icono: apuntar y cerrar ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let quickRunning = false;
async function quickAdd() {
  show('hoy');
  add();
  if (!cfg.autoClose || !isStandalone() || quickRunning) return;
  quickRunning = true;
  const ov = $('#quick');
  const total = totalsByDay()[todayKey()] || 0;
  $('#quickMl').textContent = `+${cfg.sip} ml`;
  $('#quickTotal').textContent = `${fmtMl(total)} de ${fmtMl(cfg.goal)} ml hoy`;
  $('#quickExit').hidden = true;
  ov.hidden = false;
  $('#toast').hidden = true;
  let cancelled = false;
  ov.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('#quickExit')) return;
    cancelled = true; ov.hidden = true;
  }, { once: true });

  // El guardado lo termina el service worker aunque la app ya no esté en pantalla
  // (el servidor ignora duplicados por id, así que la sincronización normal no repite nada).
  clearTimeout(syncTimer);
  sync();
  handOffToSW();

  await sleep(700);
  quickRunning = false;
  if (cancelled) return;
  if (!(await leaveApp())) $('#quickExit').hidden = false; // el sistema no dejó salir solo: botón «Salir»
}

async function handOffToSW() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    const ops = queue.filter((o) => o.type === 'add');
    if (reg?.active && ops.length && cfg.url) reg.active.postMessage({ type: 'save', ops });
  } catch {}
}

// Android no deja cerrar una app web instalada con window.close(); en su lugar se manda al usuario
// a la pantalla de inicio (acción HOME de Android), lo que deja la app en segundo plano.
const HOME_INTENT = 'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.HOME;launchFlags=0x10000000;end';
async function leaveApp() {
  try { window.close(); } catch {}
  await sleep(150);
  if (document.visibilityState === 'hidden') return true;
  if (/android/i.test(navigator.userAgent)) {
    location.href = HOME_INTENT;
    await sleep(600);
    if (document.visibilityState === 'hidden') return true;
  }
  return false;
}

function initLaunch() {
  const initialHref = location.href;
  const hasParams = location.search.length > 1;
  let initialDone = false; // la URL inicial ya se procesó (por timeout o por launchQueue)
  let firstCall = true;
  if ('launchQueue' in window) {
    // Con la app ya abierta (launch_handler: focus-existing) cada toque en el icono llega aquí sin recargar.
    window.launchQueue.setConsumer((params) => {
      if (!params.targetURL) return;
      const first = firstCall;
      firstCall = false;
      if (first && hasParams && params.targetURL === initialHref) {
        if (initialDone) return; // ya sumado por el temporizador
        initialDone = true;
      }
      handleLaunchUrl(params.targetURL);
    });
  }
  if (hasParams) {
    history.replaceState(null, '', location.pathname); // evita sumar de nuevo al recargar
    setTimeout(() => { if (!initialDone) { initialDone = true; handleLaunchUrl(initialHref); } }, 150);
  }
}

/* ---------- Eventos ---------- */
function bind() {
  $('#addBtn').addEventListener('click', () => add());
  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => add(Number(b.dataset.add))));
  $('#todayList').addEventListener('click', (ev) => {
    const id = ev.target.closest('[data-del]')?.dataset.del;
    if (id) remove(id);
  });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  $('#toastUndo').addEventListener('click', () => { $('#toast').hidden = true; toastUndo?.(); toastUndo = null; });
  $('#syncBadge').addEventListener('click', () => (cfg.url ? sync() : show('ajustes')));

  $('#cfgForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target.elements;
    cfg = {
      goal: Math.max(250, Number(f.goal.value) || DEFAULTS.goal),
      sip: Math.max(25, Number(f.sip.value) || DEFAULTS.sip),
      url: f.url.value.trim(),
      token: f.token.value.trim(),
      autoClose: f.autoClose.checked,
    };
    store.set('hidra.cfg', cfg);
    shareCfgWithSW();
    buildTicks();
    $('#cfgMsg').textContent = 'Guardado.';
    if (cfg.url) $('#cfgMsg').textContent = (await sync()) ? 'Guardado y sincronizado ✅' : 'Guardado, pero no se pudo sincronizar. Revisa la URL y la clave.';
  });
  $('#syncNow').addEventListener('click', async () => {
    $('#cfgMsg').textContent = 'Sincronizando…';
    $('#cfgMsg').textContent = (await sync()) ? 'Sincronizado ✅' : (cfg.url ? 'Error al sincronizar ❌' : 'Configura primero la URL y la clave.');
  });
  $('#exportCsv').addEventListener('click', () => {
    const rows = [['id', 'fecha_hora', 'dia', 'ml'], ...entries.map((e) => [e.id, e.ts, e.date, e.ml])];
    const blob = new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `agua-${todayKey()}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { $('#quick').hidden = true; render(); scheduleSync(200); }
  });
  window.addEventListener('online', () => scheduleSync(200));
  setInterval(render, 60 * 1000); // refresca recordatorio y cambio de día
}

/* ---------- Notificaciones push ---------- */
// El service worker necesita la configuración para consultar el total y apuntar agua desde la notificación.
async function shareCfgWithSW() {
  try {
    const c = await caches.open('hidra-cfg');
    await c.put('cfg', new Response(JSON.stringify(cfg), { headers: { 'Content-Type': 'application/json' } }));
  } catch {}
}
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64uToBytes = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
async function api(params, body) {
  const sep = cfg.url.includes('?') ? '&' : '?';
  const res = body
    ? await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: cfg.token, ...body }) })
    : await fetch(`${cfg.url}${sep}${new URLSearchParams({ ...params, token: cfg.token })}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Error del servidor');
  return data;
}
async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function renderNotif(msg) {
  const st = $('#notifState');
  $('#notifIos').hidden = !(isIos && !navigator.standalone);
  if (msg) { st.textContent = msg; return; }
  if (!pushSupported()) {
    st.textContent = isIos ? '⚠️ Abre la app desde el icono de la pantalla de inicio para poder activarlas.' : '⚠️ Este navegador no admite notificaciones push.';
    $('#notifOn').disabled = $('#notifTest').disabled = true;
    return;
  }
  const sub = await currentSub();
  const perm = Notification.permission;
  st.textContent = sub ? '✅ Activadas en este móvil.'
    : perm === 'denied' ? '🚫 Bloqueadas: actívalas en los ajustes del navegador para este sitio.' : '🔕 Desactivadas.';
  $('#notifOn').textContent = sub ? 'Desactivar notificaciones' : 'Activar notificaciones';
  $('#notifTest').disabled = !sub;
}
async function toggleNotif() {
  try {
    if (!cfg.url || !cfg.token) return renderNotif('Primero configura la URL y la clave de Google Sheets y pulsa Guardar.');
    const existing = await currentSub();
    if (existing) {
      await api(null, { action: 'unsubscribe', endpoint: existing.endpoint }).catch(() => {});
      await existing.unsubscribe();
      return renderNotif();
    }
    renderNotif('Pidiendo permiso…');
    if ((await Notification.requestPermission()) !== 'granted') return renderNotif();
    const { key } = await api({ action: 'vapid' });
    if (!key) throw new Error('Falta la clave VAPID: ejecuta configurar() en Apps Script');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
    await api(null, { action: 'subscribe', sub: sub.toJSON() });
    await shareCfgWithSW();
    renderNotif();
  } catch (err) {
    renderNotif('❌ ' + (err.message || err));
  }
}
async function testNotif() {
  try {
    renderNotif('Enviando…');
    const { result } = await api(null, { action: 'test' });
    const okCount = result.filter((r) => r.code >= 200 && r.code < 300).length;
    renderNotif(okCount ? '📨 Enviada. Debería llegarte en unos segundos.' : '❌ El servicio push rechazó el envío: ' + JSON.stringify(result));
    setTimeout(() => renderNotif(), 6000);
  } catch (err) {
    renderNotif('❌ ' + (err.message || err));
  }
}

/* ---------- Inicio ---------- */
buildTicks();
bind();
setSync(cfg.url && cfg.token ? 'busy' : 'off');
show('hoy');
initLaunch();
scheduleSync(300);
shareCfgWithSW();
$('#notifOn').addEventListener('click', toggleNotif);
$('#quickExit').addEventListener('click', async () => {
  if (!(await leaveApp())) { $('#quick').hidden = true; toast('Android no permite salir automáticamente: usa el botón de inicio.'); }
});
$('#notifTest').addEventListener('click', testNotif);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data?.type === 'launch') handleLaunchUrl(ev.data.url);
    if (ev.data?.type === 'sync') scheduleSync(100);
  });
}
