/**
 * Backend de "Hidratación" en Google Sheets + Apps Script.
 *
 * 1. Crea una hoja de cálculo nueva → Extensiones → Apps Script → pega este archivo.
 * 2. Ejecuta una vez la función `configurar` (pide permisos y genera la clave TOKEN).
 *    La clave aparece en el registro de ejecución: cópiala en Ajustes de la app.
 * 3. Implementar → Nueva implementación → Aplicación web
 *    · Ejecutar como: Yo   · Quién tiene acceso: Cualquier usuario
 *    Copia la URL que termina en /exec y pégala en Ajustes de la app.
 * 4. (Opcional) Ejecuta `activarRecordatorios` para recibir un correo si llevas 2 h sin beber (9–21 h).
 */

const HOJA = 'Registro';
const OBJETIVO_ML = 2000;
const RECORDATORIO_HORAS = 2;
const HORA_INICIO = 9;
const HORA_FIN = 21;
const DIAS_DEVUELTOS = 400;
// Pon aquí la URL de GitHub Pages para que el correo incluya un enlace directo (opcional).
const URL_APP = '';

/* ---------- Configuración ---------- */
function configurar() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }
  hoja_();
  Logger.log('TOKEN (cópialo en Ajustes de la app): ' + token);
}

function activarRecordatorios() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'recordatorio')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('recordatorio').timeBased().everyMinutes(30).create();
  Logger.log('Recordatorios activados: se comprueba cada 30 min.');
}

function desactivarRecordatorios() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'recordatorio')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  Logger.log('Recordatorios desactivados.');
}

/* ---------- API web ---------- */
function doGet(e) {
  if (!tokenOk_(e.parameter.token)) return json_({ ok: false, error: 'Clave incorrecta' });
  return json_({ ok: true, entries: listar_() });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'JSON inválido' }); }
  if (!tokenOk_(body.token)) return json_({ ok: false, error: 'Clave incorrecta' });

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = hoja_();
    const ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues() : [];
    const fila = {};
    ids.forEach((r, i) => { fila[String(r[0])] = i + 2; });

    const nuevas = [];
    (body.ops || []).forEach((op) => {
      if (op.type === 'add' && op.entry && !fila[op.entry.id]) {
        const en = op.entry;
        nuevas.push([String(en.id), String(en.ts), String(en.date), Number(en.ml) || 0, '']);
        fila[en.id] = -1; // evita duplicados dentro del mismo envío
      } else if (op.type === 'del' && fila[op.id] > 0) {
        sh.getRange(fila[op.id], 5).setValue('sí');
      }
    });
    if (nuevas.length) {
      const desde = sh.getLastRow() + 1;
      sh.getRange(desde, 1, nuevas.length, 5).setValues(nuevas);
      // Los borrados de entradas añadidas en este mismo envío
      (body.ops || []).forEach((op) => {
        if (op.type !== 'del') return;
        const i = nuevas.findIndex((n) => n[0] === op.id);
        if (i >= 0) sh.getRange(desde + i, 5).setValue('sí');
      });
    }
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true, entries: listar_() });
}

/* ---------- Recordatorio por correo ---------- */
function recordatorio() {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const ahora = new Date();
  const hora = Number(Utilities.formatDate(ahora, tz, 'H'));
  if (hora < HORA_INICIO || hora >= HORA_FIN) return;

  const hoy = Utilities.formatDate(ahora, tz, 'yyyy-MM-dd');
  const regs = listar_();
  const total = regs.filter((r) => r.date === hoy).reduce((s, r) => s + r.ml, 0);
  if (total >= OBJETIVO_ML) return;

  const ultimo = regs.length ? new Date(regs[regs.length - 1].ts).getTime() : 0;
  const props = PropertiesService.getScriptProperties();
  const ultimoAviso = Number(props.getProperty('ULTIMO_AVISO') || 0);
  const umbral = RECORDATORIO_HORAS * 3600 * 1000;
  if (ahora - ultimo < umbral || ahora - ultimoAviso < umbral) return;

  const faltan = OBJETIVO_ML - total;
  const cuerpo = `Llevas ${total} ml de ${OBJETIVO_ML} ml hoy. Te faltan ${faltan} ml (unos ${Math.ceil(faltan / 125)} medios vasos).` +
    (URL_APP ? `\n\nSumar medio vaso: ${URL_APP}?beber=1` : '');
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '💧 Hora de beber agua', cuerpo);
  props.setProperty('ULTIMO_AVISO', String(ahora.getTime()));
}

/* ---------- Utilidades ---------- */
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

function tokenOk_(t) {
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return !!token && t === token;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
