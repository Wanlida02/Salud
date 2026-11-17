/**
 * Backend de "Hidratación" en Google Sheets + Apps Script.
 * Guarda los registros en la hoja y envía notificaciones push (Web Push) al móvil.
 *
 * 1. En la hoja: Extensiones → Apps Script → pega este archivo y guarda.
 * 2. Ejecuta una vez `configurar` (acepta los permisos). Copia el TOKEN del registro de ejecución.
 * 3. Implementar → Nueva implementación → Aplicación web
 *    · Ejecutar como: Yo   · Quién tiene acceso: Cualquier usuario  → copia la URL /exec.
 * 4. Ejecuta `activarRecordatorios` (comprueba cada 30 min y avisa si llevas 2 h sin beber, 9–21 h).
 * 5. En la app → Ajustes: pega URL y TOKEN, guarda y pulsa «Activar notificaciones».
 */

const HOJA = 'Registro';
const OBJETIVO_ML = 2000;
const MEDIO_VASO_ML = 125;
const RECORDATORIO_HORAS = 2;
const HORA_INICIO = 9;
const HORA_FIN = 21;
const DIAS_DEVUELTOS = 400;
const URL_APP = 'https://wanlida02.github.io/Salud/';

/* ================= Configuración ================= */
function configurar() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  if (!props.getProperty('VAPID_D')) {
    const kp = Vapid.generar(bytesAleatorios_(32));
    props.setProperty('VAPID_D', kp.d);
    props.setProperty('VAPID_PUB', kp.pub);
  }
  hoja_();
  UrlFetchApp.getRequest(URL_APP); // fuerza el permiso de conexiones externas (necesario para push)
  Logger.log('TOKEN (cópialo en Ajustes de la app): ' + props.getProperty('TOKEN'));
}

function activarRecordatorios() {
  desactivarRecordatorios();
  ScriptApp.newTrigger('recordatorio').timeBased().everyMinutes(30).create();
  Logger.log('Recordatorios activados: se comprueba cada 30 min.');
}

function desactivarRecordatorios() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'recordatorio')
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

/** Envía una notificación ahora mismo a todos los móviles suscritos. */
function probarNotificacion() {
  Logger.log(JSON.stringify(enviarPushATodos_()));
}

/* ================= API web ================= */
function doGet(e) {
  const p = e.parameter;
  if (!tokenOk_(p.token)) return json_({ ok: false, error: 'Clave incorrecta' });
  if (p.action === 'vapid') return json_({ ok: true, key: PropertiesService.getScriptProperties().getProperty('VAPID_PUB') });
  if (p.action === 'hoy') return json_({ ok: true, total: totalDia_(listar_(), p.date || hoyStr_()), goal: OBJETIVO_ML });
  if (p.action === 'beber') return beberRapido_(Number(p.ml) || MEDIO_VASO_ML);
  return json_({ ok: true, entries: listar_() });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'JSON inválido' }); }
  if (!tokenOk_(body.token)) return json_({ ok: false, error: 'Clave incorrecta' });

  if (body.action === 'subscribe') return json_({ ok: true, subs: guardarSuscripcion_(body.sub) });
  if (body.action === 'unsubscribe') { borrarSuscripcion_(body.endpoint); return json_({ ok: true }); }
  if (body.action === 'test') return json_({ ok: true, result: enviarPushATodos_() });

  aplicarOps_(body.ops || []);
  const entries = listar_();
  if (body.date) return json_({ ok: true, entries, total: totalDia_(entries, body.date) });
  return json_({ ok: true, entries });
}

function aplicarOps_(ops) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = hoja_();
    const ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues() : [];
    const fila = {};
    ids.forEach((r, i) => { fila[String(r[0])] = i + 2; });
    const nuevas = [];
    ops.forEach((op) => {
      if (op.type === 'add' && op.entry && !fila[op.entry.id]) {
        const en = op.entry;
        nuevas.push([String(en.id), String(en.ts), String(en.date), Number(en.ml) || 0, '']);
        fila[en.id] = -1;
      } else if (op.type === 'del' && fila[op.id] > 0) {
        sh.getRange(fila[op.id], 5).setValue('sí');
      }
    });
    if (nuevas.length) {
      const desde = sh.getLastRow() + 1;
      sh.getRange(desde, 1, nuevas.length, 5).setValues(nuevas);
      ops.forEach((op) => {
        if (op.type !== 'del') return;
        const i = nuevas.findIndex((n) => n[0] === op.id);
        if (i >= 0) sh.getRange(desde + i, 5).setValue('sí');
      });
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Para el atajo «Beber» de iPhone (app Atajos) o HTTP Shortcuts en Android:
 * GET …/exec?action=beber&token=XXX → apunta medio vaso y devuelve un texto corto para el aviso.
 */
function beberRapido_(ml) {
  const ahora = new Date();
  const entry = { id: 'a' + Utilities.getUuid().replace(/-/g, '').slice(0, 12), ts: ahora.toISOString(), date: hoyStr_(), ml };
  aplicarOps_([{ type: 'add', entry }]);
  const total = totalDia_(listar_(), entry.date);
  const texto = total >= OBJETIVO_ML
    ? `🎉 +${ml} ml · ¡Objetivo cumplido! ${total} ml hoy`
    : `💧 +${ml} ml · Llevas ${total} de ${OBJETIVO_ML} ml`;
  return ContentService.createTextOutput(texto).setMimeType(ContentService.MimeType.TEXT);
}

/* ================= Recordatorio (push) ================= */
function recordatorio() {
  // Aviso de ritmo: el ideal es repartir el objetivo de forma lineal entre HORA_INICIO y HORA_FIN.
  // En cada control (13, 16 y 19 h), si vas al menos un vaso (250 ml) por detrás, se envía un aviso.
  const CONTROLES_RITMO = [13, 16, 19];
  const MARGEN_RITMO_ML = 250;

  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const ahora = new Date();
  const hora = Number(Utilities.formatDate(ahora, tz, 'H')) + Number(Utilities.formatDate(ahora, tz, 'm')) / 60;
  if (hora < HORA_INICIO || hora >= HORA_FIN) return;

  const hoy = hoyStr_();
  const regs = listar_();
  const total = totalDia_(regs, hoy);
  if (total >= OBJETIVO_ML) return;

  const props = PropertiesService.getScriptProperties();
  const ultimoAviso = Number(props.getProperty('ULTIMO_AVISO') || 0);

  // 1) ¿Vamos por detrás del ritmo en el último control alcanzado? (como mucho 1 aviso por hora)
  const esperado = OBJETIVO_ML * (hora - HORA_INICIO) / (HORA_FIN - HORA_INICIO);
  const control = CONTROLES_RITMO.filter((h) => hora >= h).pop();
  const clave = hoy + '|' + control;
  if (control && esperado - total >= MARGEN_RITMO_ML && props.getProperty('RITMO') !== clave &&
      ahora - ultimoAviso >= 55 * 60 * 1000) {
    enviarPushATodos_(); // el móvil calcula el mismo ritmo y muestra el aviso «Vas por detrás»
    props.setProperty('RITMO', clave);
    props.setProperty('ULTIMO_AVISO', String(ahora.getTime()));
    return;
  }

  // 2) Recordatorio normal: 2 h sin beber
  const ultimo = regs.length ? new Date(regs[regs.length - 1].ts).getTime() : 0;
  const umbral = RECORDATORIO_HORAS * 3600 * 1000 - 5 * 60 * 1000; // margen de 5 min por el disparador
  if (ahora - ultimo < umbral || ahora - ultimoAviso < umbral) return;

  enviarPushATodos_();
  props.setProperty('ULTIMO_AVISO', String(ahora.getTime()));
}

/**
 * Push sin contenido: el móvil despierta su service worker, que consulta el total del día
 * y muestra la notificación. Así no hace falta cifrar el mensaje.
 */
function enviarPushATodos_() {
  const props = PropertiesService.getScriptProperties();
  const d = props.getProperty('VAPID_D'), pub = props.getProperty('VAPID_PUB');
  if (!d) throw new Error('Ejecuta primero configurar()');
  const subs = suscripciones_();
  const resultado = [];
  const caducadas = [];
  subs.forEach((s) => {
    const aud = s.endpoint.match(/^https:\/\/[^/]+/)[0];
    const jwt = Vapid.jwt(d, { aud, exp: Math.floor(Date.now() / 1000) + 3600, sub: URL_APP });
    const res = UrlFetchApp.fetch(s.endpoint, {
      method: 'post',
      headers: { TTL: '3600', Urgency: 'high', Authorization: 'vapid t=' + jwt + ', k=' + pub },
      payload: '',
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    resultado.push({ host: aud, code });
    if (code === 404 || code === 410) caducadas.push(s.endpoint);
  });
  caducadas.forEach(borrarSuscripcion_);
  return resultado;
}

/* ================= Suscripciones ================= */
function suscripciones_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('SUBS') || '[]');
}
function guardarSuscripcion_(sub) {
  if (!sub || !/^https:\/\//.test(sub.endpoint || '')) throw new Error('Suscripción no válida');
  const subs = suscripciones_().filter((s) => s.endpoint !== sub.endpoint);
  subs.push({ endpoint: sub.endpoint, alta: new Date().toISOString() });
  PropertiesService.getScriptProperties().setProperty('SUBS', JSON.stringify(subs.slice(-10)));
  return subs.length;
}
function borrarSuscripcion_(endpoint) {
  const subs = suscripciones_().filter((s) => s.endpoint !== endpoint);
  PropertiesService.getScriptProperties().setProperty('SUBS', JSON.stringify(subs));
}

/* ================= Utilidades ================= */
function hoja_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(HOJA);
  if (!sh) {
    sh = ss.insertSheet(HOJA);
    sh.getRange('A:C').setNumberFormat('@'); // texto: evita que Sheets convierta las fechas
    sh.appendRow(['id', 'fecha_hora', 'dia', 'ml', 'borrado']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function listar_() {
  const sh = hoja_();
  if (sh.getLastRow() < 2) return [];
  const limite = new Date(Date.now() - DIAS_DEVUELTOS * 86400000).toISOString();
  return sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues()
    .filter((r) => r[0] && !r[4] && String(r[1]) >= limite)
    .map((r) => ({ id: String(r[0]), ts: String(r[1]), date: String(r[2]), ml: Number(r[3]) }))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

function totalDia_(regs, dia) {
  return regs.filter((r) => r.date === dia).reduce((s, r) => s + r.ml, 0);
}
function hoyStr_() {
  return Utilities.formatDate(new Date(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}
function tokenOk_(t) {
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return !!token && t === token;
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function bytesAleatorios_(n) {
  let out = [];
  while (out.length < n) {
    const semilla = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid() + Date.now() + Math.random();
    out = out.concat(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, semilla).map((b) => b & 255));
  }
  return out.slice(0, n);
}

/* ================= VAPID (ECDSA P-256 / ES256) =================
 * Apps Script no trae firma ES256, así que se implementa aquí (curva P-256, nonce RFC 6979).
 */
const Vapid = (function () {
  // Apps Script no admite literales BigInt (123n): se crean con BigInt().
  const B0 = BigInt(0), B1 = BigInt(1), B2 = BigInt(2), B3 = BigInt(3), B4 = BigInt(4), B8 = BigInt(8), B255 = BigInt(255);
  const P = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
  const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const GX = BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296');
  const GY = BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5');

  const mod = (a, m) => { const r = a % m; return r < B0 ? r + m : r; };
  function powmod(b, e, m) {
    let r = B1; b = mod(b, m);
    while (e > B0) { if (e & B1) r = (r * b) % m; b = (b * b) % m; e >>= B1; }
    return r;
  }
  const inv = (a, m) => powmod(a, m - B2, m);

  function dbl(p) {
    const [X, Y, Z] = p;
    if (Z === B0 || Y === B0) return [B0, B1, B0];
    const delta = mod(Z * Z, P), gamma = mod(Y * Y, P), beta = mod(X * gamma, P);
    const alpha = mod(B3 * (X - delta) * (X + delta), P);
    const X3 = mod(alpha * alpha - B8 * beta, P);
    const Z3 = mod((Y + Z) * (Y + Z) - gamma - delta, P);
    const Y3 = mod(alpha * (B4 * beta - X3) - B8 * gamma * gamma, P);
    return [X3, Y3, Z3];
  }
  function addAffine(p, x2, y2) {
    const [X1, Y1, Z1] = p;
    if (Z1 === B0) return [x2, y2, B1];
    const Z1Z1 = mod(Z1 * Z1, P);
    const U2 = mod(x2 * Z1Z1, P), S2 = mod(y2 * Z1 * Z1Z1, P);
    const H = mod(U2 - X1, P), r = mod(S2 - Y1, P);
    if (H === B0) return r === B0 ? dbl(p) : [B0, B1, B0];
    const HH = mod(H * H, P), HHH = mod(H * HH, P), V = mod(X1 * HH, P);
    const X3 = mod(r * r - HHH - B2 * V, P);
    const Y3 = mod(r * (V - X3) - Y1 * HHH, P);
    return [X3, Y3, mod(Z1 * H, P)];
  }
  function mulG(k) {
    let R = [B0, B1, B0];
    for (let i = 255; i >= 0; i--) {
      R = dbl(R);
      if ((k >> BigInt(i)) & B1) R = addAffine(R, GX, GY);
    }
    const zi = inv(R[2], P), zi2 = mod(zi * zi, P);
    return [mod(R[0] * zi2, P), mod(R[1] * zi2 * zi, P)];
  }

  const toBig = (bytes) => bytes.reduce((a, b) => (a << B8) | BigInt(b & 255), B0);
  function toBytes(n, len) {
    const out = new Array(len);
    for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & B255); n >>= B8; }
    return out;
  }
  const signed = (arr) => arr.map((b) => (b > 127 ? b - 256 : b));
  const unsigned = (arr) => arr.map((b) => b & 255);
  const sha256 = (bytes) => unsigned(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, signed(bytes)));
  const hmac = (key, msg) => unsigned(Utilities.computeHmacSha256Signature(signed(msg), signed(key)));
  const b64u = (bytes) => Utilities.base64EncodeWebSafe(signed(bytes)).replace(/=+$/, '');
  const b64uDecode = (s) => unsigned(Utilities.base64DecodeWebSafe(s + '==='.slice((s.length + 3) % 4)));
  const utf8 = (s) => unsigned(Utilities.newBlob(s).getBytes());

  function nonce(d, h1) {
    const x = toBytes(d, 32);
    let V = new Array(32).fill(1), K = new Array(32).fill(0);
    K = hmac(K, V.concat([0], x, h1)); V = hmac(K, V);
    K = hmac(K, V.concat([1], x, h1)); V = hmac(K, V);
    for (;;) {
      V = hmac(K, V);
      const k = toBig(V);
      if (k >= B1 && k < N) return k;
      K = hmac(K, V.concat([0])); V = hmac(K, V);
    }
  }
  function sign(msgBytes, d) {
    const e = mod(toBig(sha256(msgBytes)), N);
    for (;;) {
      const k = nonce(d, toBytes(e, 32));
      const r = mod(mulG(k)[0], N);
      const s = mod(inv(k, N) * (e + r * d), N);
      if (r !== B0 && s !== B0) return toBytes(r, 32).concat(toBytes(s, 32));
    }
  }

  return {
    generar(randomBytes) {
      const d = mod(toBig(randomBytes), N - B1) + B1;
      const [x, y] = mulG(d);
      return { d: b64u(toBytes(d, 32)), pub: b64u([4].concat(toBytes(x, 32), toBytes(y, 32))) };
    },
    jwt(dB64u, claims) {
      const d = toBig(b64uDecode(dB64u));
      const input = b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))) + '.' + b64u(utf8(JSON.stringify(claims)));
      return input + '.' + b64u(sign(utf8(input), d));
    },
  };
})();
