# Twitch Streamer Overlays

> 🇬🇧 [Read in English](README.md)

App de escritorio (Electron) que pone **tu cámara** y **tu chat de Twitch** encima del juego, para que te veas y leas el chat mientras jugás.

- Cada overlay se arrastra, se redimensiona y tiene su propia opacidad.
- **Bloqueado** = los clicks atraviesan los overlays y llegan al juego. No se mueven aunque hagas click encima.
- Cámara compatible con **NVIDIA Broadcast**, con su **transparencia nativa** (también chroma key y recorte de negro en GPU).
- Chat en vivo, anónimo y de solo lectura: no hace falta login ni token.

## Requisitos

- Windows 10/11
- Node.js 20 o superior

## Arrancar

```bash
npm install
npm start
```

## Generar el .exe

```bash
npm run dist
```

Se generan dos archivos en `dist/`:

| Archivo | Para qué |
| --- | --- |
| `Twitch Streamer Overlays Setup 0.1.0.exe` | **Instalador.** Instala por usuario (sin pedir admin), crea accesos directos y un desinstalador. Arranca rápido. |
| `Twitch Streamer Overlays 0.1.0 Portable.exe` | **Portable.** No instala nada. Cada vez que lo abrís se descomprime a una carpeta temporal, así que tarda unos segundos más en arrancar. |

Los `.exe` **no están firmados** (un certificado de firma de código cuesta plata). La primera vez Windows SmartScreen muestra *"Windows protegió tu PC"*: tocá **Más información → Ejecutar de todas formas**.

La configuración se comparte entre la versión de desarrollo y la instalada, porque las dos usan `%APPDATA%\Twitch Streamer Overlays`.

## Uso

1. Se abre el **panel de control** y los dos overlays en **modo edición** (borde violeta punteado).
2. Arrastrá cada overlay desde cualquier punto y redimensionalo desde los bordes o las esquinas. También podés escribir X / Y / ancho / alto exactos en el panel.
3. En el panel escribí tu canal de Twitch y elegí la cámara.
4. Tocá **Bloquear overlays**, o usá **Ctrl+Alt+Shift+L**, que funciona aunque estés dentro del juego.
5. Para editar de nuevo: el mismo atajo otra vez, o el ícono violeta de la bandeja de Windows.

Si otra app ya usa ese atajo, se prueban alternativos (Ctrl+Alt+Shift+O, Ctrl+Alt+F12). El panel muestra cuál quedó activo.

> El juego tiene que estar en **ventana sin bordes (borderless)**. En pantalla completa exclusiva, Windows no deja dibujar ninguna ventana encima. Es una limitación del sistema operativo, no de la app.

Cerrar el panel **no** cierra la app: sigue en la bandeja. Para salir: bandeja → *Salir*.

## NVIDIA Broadcast con transparencia nativa

1. En NVIDIA Broadcast → Cámara → efecto **Eliminación de fondo**.
2. En el panel, en *Fondo transparente*, elegí **Transparencia nativa (NVIDIA Broadcast)**.

**Por qué hace falta un capturador aparte:** Chromium convierte cada cuadro de la cámara a YUV (I420), un formato sin canal alfa. La transparencia de NVIDIA se pierde ANTES de llegar a la página, y ningún shader puede recuperarla.

Por eso la app lee la cámara igual que OBS: por **DirectShow en formato ARGB32**, con un pequeño programa en C# (`native/dshow-capture.cs`). Ese programa:

- Se compila solo la primera vez, con el compilador de C# que ya viene con Windows (`csc.exe` de .NET Framework 4). No hay nada que instalar. El `.exe` queda cacheado en `%APPDATA%\Twitch Streamer Overlays\native\` y se recompila solo si cambia el código.
- Reduce cada cuadro al tamaño real del overlay antes de mandarlo, y lo invierte verticalmente, porque DirectShow entrega las filas al revés.
- Se cierra solo si la app se cierra.

Detalle medido en un equipo real: NVIDIA Broadcast *lista* 12 resoluciones, pero su pin solo *acepta* 3840×2160. El capturador lo detecta, prueba en orden y reduce el 4K en CPU (~3 % de un núcleo).

Para diagnosticar otras cámaras:

```bash
dshow-capture.exe --list                                         # formatos que publica cada cámara
dshow-capture.exe --probe-connect --device "Camera (NVIDIA Broadcast)"   # cuáles acepta de verdad
```

### Alternativas si la nativa no te sirve

- **Chroma key:** tocá *Generar imagen verde*, usala en NVIDIA → *Reemplazo de fondo* y elegí el modo **Chroma key**. Usa los mismos parámetros que el filtro de OBS.
- **Recortar negro:** no requiere tocar NVIDIA, pero también se come zonas oscuras, como pelo o ropa negra.

## Configuración

Todo se guarda solo en `%APPDATA%\Twitch Streamer Overlays\settings.json`.
El atajo de teclado se cambia ahí (`hotkeys.toggleLock`, formato [Accelerator de Electron](https://www.electronjs.org/docs/latest/api/accelerator)) y se aplica al reiniciar la app.

## Arquitectura

```
src/
  main/                       Proceso principal (Node)
    main.js                   Arranque, permisos (solo cámara, solo nuestras páginas), hardening
    overlay-controller.js     Fuente única de verdad: ventanas, bloqueo, resize, IPC, broadcast
    settings-store.js         Settings en disco + validación por lista blanca de campos
    app-protocol.js           Sirve src/renderer como app://overlay (contexto seguro)
    tray.js                   Ícono de bandeja (dibujado en código)
    green-screen-image.js     Genera el PNG verde para el modo chroma key
    native-camera.js          Proceso capturador: arranque, reinicios con debounce, parser de cuadros
    native-capture-helper.js  Compila native/dshow-capture.cs con el csc de Windows (cache por hash)
  preload/preload.js          Único puente expuesto a las páginas (contextBridge)
  renderer/
    shared/                   Marco de edición: borde, etiqueta y handles de resize
    camera/                   getUserMedia o cuadros nativos + shader WebGL (alfa nativo / chroma / luma)
    chat/                     Cliente IRC de Twitch por WebSocket + render seguro (sin innerHTML)
    panel/                    Panel de control con bindings declarativos (data-bind)
native/
  dshow-capture.cs            Captura DirectShow ARGB32 → cuadros BGRA por stdout (transparencia real)
```

**Flujo de datos unidireccional:** el panel manda *patches*, el proceso principal los valida y los aplica a las ventanas reales, y después difunde el estado nuevo a todas las páginas, que solo renderizan lo que reciben. Ninguna página tiene estado propio que pueda desincronizarse.

**Por qué el resize es propio:** en Windows, las ventanas transparentes sin marco no se pueden redimensionar de forma nativa. Mientras arrastrás un handle, el proceso principal lee la posición real del cursor (`screen.getCursorScreenPoint`), que es estable. El `screenX` del renderer, en cambio, tiembla porque la ventana se mueve debajo del puntero.

## Limitaciones conocidas

- Sin badges de Twitch (mod, sub, etc.): requieren la API Helix con token.
- No funciona sobre juegos en pantalla completa exclusiva (ver arriba).
- Si todos los atajos están ocupados, el panel te avisa: desbloqueá desde la bandeja o cambiá el atajo en `settings.json`.
