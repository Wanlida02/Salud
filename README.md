# Salud · Hidratación 💧

Aplicación web (PWA) para registrar el agua que bebes. Objetivo: 2 L al día.

- **Tocar el icono "Beber"** → apunta medio vaso (125 ml), vuelve a la pantalla de inicio en ~1 s (si Android no lo permite, aparece un botón «Salir») (toca la pantalla para dejarla abierta; se puede desactivar en *Ajustes*).
- **Mantener pulsado el icono** (Android) → accesos *Progreso e historial*, *Ver el vaso de hoy*, *Beber medio vaso*.
- Dentro de la app: botón grande **+ Medio vaso**, vaso (250) y botella (500), deshacer, borrar registros.
- **Historial**: gráfico de 30 días, racha de días cumpliendo objetivo, media y lista por día.
- **Sincronización** con una hoja de Google Sheets (funciona sin conexión y se sincroniza después).
- **Notificaciones en el móvil**: si llevas 2 h sin beber (9–21 h) llega un aviso con el botón **+ Medio vaso**, que lo apunta sin abrir la app.

## 1. Publicar en GitHub Pages

La app se publica desde la rama **`gh-pages`** en **https://wanlida02.github.io/Salud/**.
Para actualizarla: `git push origin <rama>:gh-pages`.

> Si el repositorio es privado, GitHub Pages necesita un plan de pago; con un repo público funciona gratis.
> La URL y la clave de sincronización **no** están en el código: se introducen en *Ajustes* y se guardan solo en tu móvil.

## 2. Instalar en el móvil

- **Android (Chrome)**: abre la URL → menú ⋮ → *Añadir a pantalla de inicio / Instalar aplicación*.
  El icono se llama **Beber**: un toque suma medio vaso; mantenlo pulsado para ir al progreso e historial.
- **iPhone (Safari)**: Compartir → *Añadir a pantalla de inicio*. iOS no muestra los accesos al mantener pulsado;
  usa las pestañas *Hoy / Historial* dentro de la app.

## 3. Sincronización con Google Sheets (≈5 min)

1. Crea una hoja nueva en [sheets.new](https://sheets.new) (p. ej. «Hidratación»).
2. *Extensiones → Apps Script*, borra el contenido y pega [`apps-script/Code.gs`](apps-script/Code.gs). Guarda.
3. Selecciona la función **`configurar`** y pulsa ▶ *Ejecutar*. Acepta los permisos.
   En el *Registro de ejecución* aparece el **TOKEN**: cópialo.
4. *Implementar → Nueva implementación → ⚙ Aplicación web*:
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
   - Copia la **URL** que termina en `/exec`.
5. En la app → *Ajustes*: pega la URL y el TOKEN → *Guardar*. El indicador arriba a la derecha pasa a «Sincronizado».

Los datos se guardan en la pestaña **Registro** de la hoja (`id, fecha_hora, dia, ml, borrado`).
Si cambias el código del script, usa *Implementar → Gestionar implementaciones → Editar → Nueva versión* para mantener la misma URL.

## 4. Notificaciones en el móvil

1. En Apps Script ejecuta **`activarRecordatorios`** (comprueba cada 30 min; avisa si llevas 2 h sin beber, de 9 a 21 h,
   zona horaria de la hoja, y como máximo un aviso cada 2 h).
2. En la app → *Ajustes → Notificaciones* → **Activar notificaciones** y acepta el permiso.
3. Pulsa **Enviar prueba**: debe llegarte una notificación en unos segundos.

- **Android**: la notificación trae los botones *+ Medio vaso* (lo apunta en la hoja sin abrir la app) y *Ver vaso*.
- **iPhone (iOS 16.4+)**: hay que abrir la app desde el icono de la pantalla de inicio para activarlas. iOS no muestra
  botones en la notificación: al tocarla se abre el vaso.

Cómo funciona: Apps Script envía un *push* (Web Push con firma VAPID generada en `configurar`) al servicio de notificaciones
del móvil; el service worker de la app consulta el total del día y muestra el aviso. Para parar: `desactivarRecordatorios`.
Si cambias el código del script: *Implementar → Gestionar implementaciones → Editar → Versión: nueva* (la URL no cambia).

## Estructura

| Archivo | Qué es |
|---|---|
| `index.html`, `styles.css`, `app.js` | La aplicación |
| `manifest.webmanifest` | Icono, `start_url=?beber=1` y accesos directos al mantener pulsado |
| `sw.js` | Funcionamiento sin conexión y notificaciones push |
| `apps-script/Code.gs` | Backend en Google Sheets + envío de notificaciones |

Parámetros de URL útiles (también para el futuro tablón personal):
`?beber=1` suma medio vaso · `?ver=historial` abre el historial · `?ver=hoy` abre el vaso.
