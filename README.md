# Salud · Hidratación 💧

Aplicación web (PWA) para registrar el agua que bebes. Objetivo: 2 L al día.

- **Tocar el icono "Beber"** → suma medio vaso (125 ml) y muestra el vaso llenándose.
- **Mantener pulsado el icono** (Android) → accesos *Progreso e historial*, *Ver el vaso de hoy*, *Beber medio vaso*.
- Dentro de la app: botón grande **+ Medio vaso**, vaso (250) y botella (500), deshacer, borrar registros.
- **Historial**: gráfico de 30 días, racha de días cumpliendo objetivo, media y lista por día.
- **Sincronización** con una hoja de Google Sheets (funciona sin conexión y se sincroniza después).
- **Recordatorios**: aviso en la app y correo si llevas 2 h sin beber entre las 9 y las 21 h.

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

## 4. Recordatorios por correo (opcional)

En Apps Script, rellena `URL_APP` con la URL de GitHub Pages (para que el correo traiga el enlace directo)
y ejecuta **`activarRecordatorios`**. Cada 30 min comprueba si llevas 2 h sin beber (9–21 h, zona horaria de la hoja)
y, si no has llegado al objetivo, te envía un correo; como máximo uno cada 2 h. Para pararlo: `desactivarRecordatorios`.

Truco: crea en Gmail un filtro para el asunto «Hora de beber agua» con una etiqueta que tenga notificaciones activadas.

## Estructura

| Archivo | Qué es |
|---|---|
| `index.html`, `styles.css`, `app.js` | La aplicación |
| `manifest.webmanifest` | Icono, `start_url=?beber=1` y accesos directos al mantener pulsado |
| `sw.js` | Funcionamiento sin conexión |
| `apps-script/Code.gs` | Backend en Google Sheets + recordatorios |

Parámetros de URL útiles (también para el futuro tablón personal):
`?beber=1` suma medio vaso · `?ver=historial` abre el historial · `?ver=hoy` abre el vaso.
