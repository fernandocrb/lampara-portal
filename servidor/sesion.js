// Acceso al panel de administración.
//
// Un solo administrador, contraseña en variable de entorno guardada como hash
// scrypt — nunca en claro, ni en el repo ni en la base. Las sesiones viven en
// memoria: reiniciar el servidor obliga a entrar de nuevo, que para un panel
// que usa una persona es una molestia menor a cambio de no tener que invalidar
// tokens persistentes si algo sale mal.
//
// Esto es la segunda cerradura, no la única: la primera es Cloudflare Access
// delante del túnel (ver README). Si Access se cae o se configura mal, esta
// contraseña sigue de pie.
'use strict';

const crypto = require('crypto');

const NOMBRE_COOKIE = 'lampara_sesion';
const DURACION_MS = 8 * 60 * 60 * 1000;

/** Tras esto, la IP espera. Frena la fuerza bruta contra una sola contraseña. */
const INTENTOS_MAXIMOS = 8;
const CASTIGO_MS = 15 * 60 * 1000;

const sesiones = new Map();
const intentos = new Map();

// ---------------------------------------------------------------------------
// Contraseña
// ---------------------------------------------------------------------------

function crearHash(clave) {
  const sal = crypto.randomBytes(16);
  const derivada = crypto.scryptSync(clave, sal, 64);
  return 'scrypt$' + sal.toString('hex') + '$' + derivada.toString('hex');
}

function claveCorrecta(clave, hashGuardado) {
  const partes = String(hashGuardado || '').split('$');
  if (partes.length !== 3 || partes[0] !== 'scrypt') return false;

  const sal = Buffer.from(partes[1], 'hex');
  const esperado = Buffer.from(partes[2], 'hex');
  let derivada;
  try {
    derivada = crypto.scryptSync(clave, sal, esperado.length);
  } catch (e) {
    return false;
  }
  // timingSafeEqual y no `===`: comparar cadenas se corta en el primer byte
  // distinto y eso, medido, filtra el contenido del hash.
  return derivada.length === esperado.length && crypto.timingSafeEqual(derivada, esperado);
}

// ---------------------------------------------------------------------------
// Intentos
// ---------------------------------------------------------------------------

function castigada(ip) {
  const registro = intentos.get(ip);
  if (!registro) return 0;
  if (registro.fallos < INTENTOS_MAXIMOS) return 0;
  const restan = registro.hasta - Date.now();
  if (restan <= 0) {
    intentos.delete(ip);
    return 0;
  }
  return Math.ceil(restan / 60000);
}

function anotarFallo(ip) {
  const registro = intentos.get(ip) || { fallos: 0, hasta: 0 };
  registro.fallos += 1;
  if (registro.fallos >= INTENTOS_MAXIMOS) registro.hasta = Date.now() + CASTIGO_MS;
  intentos.set(ip, registro);
}

function limpiarFallos(ip) {
  intentos.delete(ip);
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------

function abrirSesion() {
  const token = crypto.randomBytes(32).toString('base64url');
  // El token CSRF va aparte del de sesión: la cookie viaja sola en cada POST y
  // sin un segundo valor que solo está en el HTML, otro sitio podría enviar
  // formularios en nombre del administrador ya logueado.
  sesiones.set(token, { creada: Date.now(), csrf: crypto.randomBytes(24).toString('base64url') });
  return token;
}

function sesionValida(token) {
  const sesion = sesiones.get(token);
  if (!sesion) return null;
  if (Date.now() - sesion.creada > DURACION_MS) {
    sesiones.delete(token);
    return null;
  }
  return sesion;
}

function cerrarSesion(token) {
  sesiones.delete(token);
}

function csrfCorrecto(sesion, enviado) {
  if (!sesion || !enviado) return false;
  const a = Buffer.from(sesion.csrf);
  const b = Buffer.from(String(enviado));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function leerCookie(cabecera, nombre) {
  for (const trozo of String(cabecera || '').split(';')) {
    const [clave, ...resto] = trozo.trim().split('=');
    if (clave === nombre) return decodeURIComponent(resto.join('='));
  }
  return null;
}

/**
 * `Secure` solo cuando de verdad se sirve por HTTPS: en desarrollo se entra por
 * http://localhost y con Secure el navegador descartaría la cookie, dejando el
 * panel imposible de usar en el propio equipo.
 */
function cabeceraCookie(token, { seguro }) {
  const partes = [
    NOMBRE_COOKIE + '=' + encodeURIComponent(token),
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=' + Math.floor(DURACION_MS / 1000),
  ];
  if (seguro) partes.push('Secure');
  return partes.join('; ');
}

function cabeceraCookieBorrada() {
  return NOMBRE_COOKIE + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
}

module.exports = {
  NOMBRE_COOKIE,
  INTENTOS_MAXIMOS,
  crearHash,
  claveCorrecta,
  castigada,
  anotarFallo,
  limpiarFallos,
  abrirSesion,
  sesionValida,
  cerrarSesion,
  csrfCorrecto,
  leerCookie,
  cabeceraCookie,
  cabeceraCookieBorrada,
};
