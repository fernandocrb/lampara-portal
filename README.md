# Portal de licencias de Lámpara

Emite y renueva los archivos firmados que valida [Lámpara](../lampara), el
software de proyección para iglesias de EducaPanama. Es un proyecto aparte
porque se despliega en un servidor: no tiene sentido llevar allí 70 MB de
Biblias y una app de Electron para firmar un JSON.

## Qué hace

Dos superficies en el mismo proceso:

| | |
|---|---|
| `GET /licencias/{clienteId}` | Público, sin contraseña. Lo llama la app de cada iglesia al arrancar y cada 6 horas. Devuelve un archivo firmado nuevo con 30 días de autonomía. |
| `/admin` | El panel, detrás de contraseña. Alta de iglesias, renovaciones, cortes y descarga manual del archivo. |
| `GET /salud` | Para el monitoreo del contenedor. |

**Sin dependencias.** SQLite viene dentro de Node 24 (`node:sqlite`) y el
servidor es `http` nativo. No hay `npm install`, no hay `node_modules`, no hay
nada que actualizar por seguridad en un servicio expuesto a internet.

## Lo que este servidor NO decide

No decide si la app deja proyectar. **Eso lo decide la app leyendo la firma.**
La distinción importa:

- Si el portal se cae un fin de semana, ninguna iglesia se queda sin culto: el
  archivo que ya tienen vale 30 días.
- Si alguien suplanta el servidor, no consigue nada: sin la clave privada no
  puede fabricar una licencia que la app acepte.
- Si alguien roba la base de datos, se lleva nombres y teléfonos de iglesias.
  Lo único irreemplazable es `datos/licencia-privada.pem`.

## Los dos relojes

Se confunden fácil y son cosas distintas:

- **`vigente_hasta`** (lo lleva el portal): hasta cuándo pagó la iglesia.
- **`validoHasta`** (lo lleva el archivo, lo lee la app): cuánto aguanta *ese
  archivo* sin volver a consultar.

Cada emisión manda el menor de los dos. Por eso dejar de pagar surte efecto sin
que la app tenga que preguntar nada en un momento exacto, y por eso una iglesia
al día nunca depende de que haya internet el domingo.

## La prueba de 30 días la cuenta el servidor

Todas las instalaciones salen del mismo instalador y comparten el cliente
`prueba-30-dias`. Lo que distingue una prueba de otra es la **huella del
equipo** que manda la app (`?equipo=`): un hash del identificador de instalación
de Windows, nunca el dato original.

El portal anota la primera vez que ve cada huella, y esa fecha no se pisa nunca.
Así, borrar `%APPDATA%\Lampara` —o desinstalar y reinstalar Lámpara entera— sigue
dando 30 días *en local*, pero el primer arranque con internet los corrige.

**Lo que esto no cierra:** editar el código de la app para saltarse la
comprobación. Eso no tiene solución real en software instalado, en ningún
programa. Ver "Hasta dónde llega esto" más abajo.

## Cuántas computadoras puede usar una iglesia

Cada iglesia tiene un número de `equipos_permitidos` (1 por defecto, editable
desde su ficha en el panel). Los equipos van tomando las licencias libres solos
al conectarse — la primera vez que preguntan, si hay cupo. Cuando ya no queda
ninguna, el que llega tarde recibe una licencia firmada de verdad, pero con
`estado: "otro_equipo"`: la app la valida, pero no proyecta con ella.

Esto **no** toca el estado de cuenta de la iglesia en la base de datos —sigue
"activo" para los equipos que sí tienen licencia— es una respuesta aparte,
calculada en el momento, solo para quien preguntó de más.

Desde el panel se puede:
- **Subir el número** de computadoras — desbloquea al instante al equipo que
  estaba esperando cupo, sin tocar nada en la app.
- **Autorizar** un equipo a mano (respeta el número: si ya está lleno, no deja).
- **Dar de baja** un equipo — libera su licencia para otro, y ese equipo queda
  bloqueado *a propósito*: no la vuelve a tomar solo en su próximo arranque.

Bajar el número no desconecta a nadie de callado: si quedan más equipos activos
que licencias, el panel lo muestra y hay que elegir a mano cuál se queda.

## Puesta en marcha (desarrollo)

```bash
cd lampara-portal
npm run claves          # genera el par de firma — una sola vez
npm run clave-admin     # inventa la contraseña del panel y da su hash
```

Después, con el hash en el entorno:

```bash
LAMPARA_ADMIN_CLAVE_HASH='scrypt$...' npm start
```

Y el panel queda en <http://localhost:8099/admin>.

En PowerShell:

```bash
$env:LAMPARA_ADMIN_CLAVE_HASH='scrypt$...'; npm start
```

### Pruebas

```bash
npm run probar
```

51 comprobaciones: levanta el portal de verdad sobre una base temporal y lo
interroga por HTTP. Cubre la firma, los dos relojes, la prueba anclada por
equipo, cuántas computadoras puede usar cada iglesia, el límite de peticiones,
el CSRF y el escapado del HTML.

Una de ellas comprueba que el nombre del formato siga coincidiendo con el de
`app/lib/licencia.js` en el repo de la app. Ese contrato vive en dos repos y
nadie notaría que se rompió hasta que una iglesia se quede sin proyectar un
domingo — por eso se comprueba sola, y por eso conviene tener ambos repos como
carpetas hermanas.

## Despliegue en el TrueNAS

TrueNAS SCALE (Community, la que se usa aquí) instala apps propias como
**Custom App**, y esa pantalla solo *jala* una imagen ya construida — no
compila un `Dockerfile`. Por eso el camino no es `docker compose up` en el
NAS: es publicar la imagen en un registro y apuntar TrueNAS ahí.

1. **La imagen se publica sola.** `.github/workflows/publicar-imagen.yml`
   construye y sube `ghcr.io/fernandocrb/lampara-portal:latest` en cada push a
   `main`. El repo es público a propósito — la imagen no lleva ningún secreto,
   ni la clave de firma ni la contraseña del panel, esas nacen después, en el
   volumen del propio NAS — así que no hace falta configurar ninguna
   credencial de registro en TrueNAS para poder jalarla.

2. **Instalar como Custom App**: Apps → Discover Apps → Custom App.
   - Repository: `ghcr.io/fernandocrb/lampara-portal`, Tag: `latest`.
   - Variables de entorno: `LAMPARA_URL_PUBLICA`, `LAMPARA_ADMIN_CLAVE_HASH`
     (generada con `npm run clave-admin`) y `LAMPARA_TRAS_PROXY=si`.
   - Storage: un volumen persistente montado en `/datos` — es lo único que
     hay que respaldar.
   - Sin puerto publicado al host: el túnel llega al contenedor por la red
     interna de apps de TrueNAS, no por la LAN.

3. **Apuntar el túnel.** El NAS ya tiene la app `cloudflared` corriendo (la
   misma que usa OpenClaw) con un *tunnel token* — el mapeo de hostnames no se
   toca ahí, se administra en Cloudflare Zero Trust → Networks → Tunnels →
   [el túnel] → Public Hostnames: agregar `licencias.educapanama.net` →
   `http://<nombre-o-IP-del-contenedor-portal>:8099`.

4. **Poner Cloudflare Access delante de `/admin`** — una política que solo
   deje entrar a tu correo. La contraseña del panel es la segunda cerradura,
   no la única.

5. **Generar la clave de firma dentro del contenedor**, para que la privada
   nazca en el servidor y no viaje por ningún lado — desde la consola del
   contenedor en TrueNAS (Apps → lampara-portal → ⋮ → Shell):

   ```bash
   node herramientas/generar-claves.js
   ```

6. **Copiar la clave pública que imprime** a `app/recursos/licencia-clave-publica.pem`
   en el repo de la app, y volver a empaquetar. Hasta que se haga esto, la app
   valida contra la clave de desarrollo y **rechazará todo lo que emita el
   portal** — que es exactamente lo que debe hacer.

7. **Apuntar la app al portal:** poner la dirección pública en
   `URL_PORTAL_LICENCIAS` (`app/lib/licencia.js`).

Para probar el mismo despliegue fuera de TrueNAS (un VPS, por ejemplo) sí sirve
`docker-compose.yml` tal cual — ahí compone la misma imagen de GHCR con su
propio `cloudflared`, sin depender de la app nativa del NAS.

### Respaldos

Lo único que hay que respaldar es el volumen `lampara-datos`, y de ahí lo único
irreemplazable es `licencia-privada.pem`. Si se pierde, **todas** las licencias
instaladas dejan de validar y hay que reinstalar Lámpara en cada iglesia.

La base de datos sí se puede reconstruir a mano: son unas pocas iglesias.

## Hasta dónde llega esto

Conviene tenerlo claro para no vender lo que no es:

| Intento | ¿Lo detiene? |
|---|---|
| Borrar `licencia.json` | Sí. La app recuerda que estuvo licenciada y queda bloqueada. |
| Borrar `%APPDATA%\Lampara` entero para reiniciar la prueba | Sí, en cuanto haya internet: el portal recuerda el equipo. |
| Editar el archivo de licencia (fechas, estado) | Sí. La firma Ed25519 no cuadra. |
| Copiar la licencia de una iglesia a otro equipo | Sí, si ya usa todas sus computadoras permitidas: el equipo de más recibe una licencia que no proyecta. Se ve en el panel, y subir el número o autorizarlo a mano lo resuelve en el momento. |
| Adivinar el identificador de otra iglesia | El identificador lleva seis hexadecimales aleatorios y hay límite de peticiones. |
| **Editar el código de la app** | **No.** Ese código corre en la máquina de quien lo edita y puede quitar la comprobación entera. No hay defensa real; solo encarecerlo. |

El riesgo realista de este negocio no es un experto crackeando el `.asar`: es
una iglesia pasándole el instalador a la iglesia amiga. Contra eso, la huella
por equipo y el portal sí funcionan, porque nadie en esa cadena va a parchear un
binario.
