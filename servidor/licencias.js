// Emisión de licencias firmadas.
//
// Este módulo es la contraparte de `app/lib/licencia.js` en el repo de la app:
// produce exactamente los bytes que aquella verifica. El formato no se puede
// cambiar aquí de forma unilateral — hay instalaciones en iglesias validando
// contra él, y una app vieja con un formato nuevo se queda sin proyectar.
//
//   { formato: "lampara-licencia-1", payload: <JSON en base64url>, firma: <Ed25519 en base64> }
//
// La firma cubre los bytes del payload en base64url, no el objeto reconstruido:
// así reindentar o reordenar claves no invalida una licencia buena.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMATO = 'lampara-licencia-1';

/** Los estados de cuenta: los que se pueden poner a mano desde el panel. */
const ESTADOS = ['activo', 'moroso', 'suspendido'];

/**
 * Estados que decide el propio servidor al emitir, no una persona en el panel.
 * `otro_equipo` es el único hoy: no es que la cuenta esté mal, es que quien
 * pregunta no es el equipo autorizado. Por eso vive aparte de `ESTADOS` — no
 * tiene sentido que apareciera como botón para marcarlo a mano.
 */
const ESTADOS_DINAMICOS = ['otro_equipo'];

const MS_DIA = 24 * 60 * 60 * 1000;

/**
 * Cuántos días de autonomía lleva cada archivo emitido.
 *
 * Este número es el que sostiene la promesa de que el culto del domingo no
 * depende de internet: la app refresca al arrancar y se lleva 30 días de
 * validez. Para que el portal deje a alguien sin proyectar tendría que estar
 * caído un mes entero, no un fin de semana.
 */
const DIAS_GRACIA = 30;

/**
 * El cliente que traen todas las instalaciones recién salidas del instalador.
 *
 * Es compartido a propósito: el instalador es un solo archivo y no puede llevar
 * un identificador distinto por iglesia. Quien distingue una prueba de otra es
 * la huella del equipo, no este valor.
 */
const CLIENTE_PRUEBA = 'prueba-30-dias';

const DIAS_PRUEBA = 30;

const CARPETA_DATOS = process.env.LAMPARA_DATOS || path.join(__dirname, '..', 'datos');
const RUTA_CLAVE_PRIVADA = path.join(CARPETA_DATOS, 'licencia-privada.pem');
const RUTA_CLAVE_PUBLICA = path.join(CARPETA_DATOS, 'licencia-publica.pem');

// ---------------------------------------------------------------------------
// Claves
// ---------------------------------------------------------------------------

/**
 * Genera el par Ed25519 del portal. Se hace **una sola vez** en el servidor.
 *
 * Regenerarlo invalida de golpe todas las licencias instaladas en todas las
 * iglesias, así que no se hace solo: hay que pedirlo a propósito.
 */
function generarClaves({ forzar = false } = {}) {
  if (!forzar && fs.existsSync(RUTA_CLAVE_PRIVADA)) {
    throw new Error(
      'Ya existe una clave privada en ' + RUTA_CLAVE_PRIVADA + '. ' +
        'Regenerarla invalidaría las licencias de todas las iglesias instaladas.'
    );
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(CARPETA_DATOS, { recursive: true });
  fs.writeFileSync(RUTA_CLAVE_PRIVADA, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(RUTA_CLAVE_PUBLICA, publicKey.export({ type: 'spki', format: 'pem' }));
  return { privada: RUTA_CLAVE_PRIVADA, publica: RUTA_CLAVE_PUBLICA };
}

function clavePrivada() {
  if (!fs.existsSync(RUTA_CLAVE_PRIVADA)) {
    throw new Error('Falta la clave de firma. Genérala con: npm run claves');
  }
  return crypto.createPrivateKey(fs.readFileSync(RUTA_CLAVE_PRIVADA, 'utf8'));
}

/** El texto PEM que hay que copiar a `app/recursos/licencia-clave-publica.pem`. */
function clavePublicaPem() {
  if (!fs.existsSync(RUTA_CLAVE_PUBLICA)) return null;
  return fs.readFileSync(RUTA_CLAVE_PUBLICA, 'utf8');
}

// ---------------------------------------------------------------------------
// Emisión
// ---------------------------------------------------------------------------

/**
 * Hasta cuándo vale el archivo que se emite ahora.
 *
 * Son dos relojes distintos y conviene no confundirlos: `vigenteHasta` es hasta
 * cuándo pagó la iglesia (lo lleva el portal) y `validoHasta` es cuánto aguanta
 * *este archivo* sin volver a consultar (lo lleva la app). Mandar el menor de
 * los dos es lo que hace que dejar de pagar tenga efecto sin necesidad de que
 * la app pregunte nada en el momento exacto.
 */
function calcularValidoHasta(vigenteHasta, ahora = Date.now()) {
  const tope = ahora + DIAS_GRACIA * MS_DIA;
  if (!vigenteHasta) return new Date(tope).toISOString();
  const pagado = new Date(vigenteHasta).getTime();
  if (isNaN(pagado)) return new Date(tope).toISOString();
  return new Date(Math.min(tope, pagado)).toISOString();
}

/**
 * Firma una licencia.
 * @returns {{texto: string, datos: object}} el archivo listo para entregar.
 */
function emitir({ clienteId, nombreCliente, estado = 'activo', plan = 'completo', vigenteHasta, diasPrueba, ahora = Date.now() }) {
  if (!clienteId) throw new Error('Falta el identificador del cliente.');
  if (!ESTADOS.includes(estado) && !ESTADOS_DINAMICOS.includes(estado)) throw new Error('Estado desconocido: ' + estado);

  const datos = {
    clienteId,
    nombreCliente: nombreCliente || '',
    estado,
    plan,
    emitidaEn: new Date(ahora).toISOString(),
    validoHasta: calcularValidoHasta(vigenteHasta, ahora),
  };

  // Solo la prueba que viaja dentro del instalador lleva esto: cuenta desde el
  // primer arranque en el equipo, no desde que se emitió.
  if (diasPrueba) datos.diasPrueba = Number(diasPrueba);

  const payload = Buffer.from(JSON.stringify(datos), 'utf8').toString('base64url');
  const firma = crypto.sign(null, Buffer.from(payload, 'utf8'), clavePrivada()).toString('base64');

  return {
    datos,
    texto: JSON.stringify({ formato: FORMATO, payload, firma }, null, 2) + '\n',
  };
}

/** Verifica un archivo emitido — se usa en las pruebas y para diagnosticar. */
function verificar(texto, pemPublica) {
  const sobre = JSON.parse(texto);
  if (sobre.formato !== FORMATO) return { valido: false, error: 'formato desconocido' };
  const clave = crypto.createPublicKey(pemPublica || clavePublicaPem());
  const firmaOk = crypto.verify(null, Buffer.from(sobre.payload, 'utf8'), clave, Buffer.from(sobre.firma, 'base64'));
  if (!firmaOk) return { valido: false, error: 'firma inválida' };
  return { valido: true, datos: JSON.parse(Buffer.from(sobre.payload, 'base64url').toString('utf8')) };
}

module.exports = {
  FORMATO,
  ESTADOS,
  ESTADOS_DINAMICOS,
  DIAS_GRACIA,
  CLIENTE_PRUEBA,
  DIAS_PRUEBA,
  MS_DIA,
  CARPETA_DATOS,
  RUTA_CLAVE_PRIVADA,
  RUTA_CLAVE_PUBLICA,
  generarClaves,
  clavePublicaPem,
  calcularValidoHasta,
  emitir,
  verificar,
};
