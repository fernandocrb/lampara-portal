// Base de datos del portal: SQLite con el módulo que trae Node 24 de fábrica
// (`node:sqlite`). Sin better-sqlite3 a propósito — es nativo, y compilarlo
// dentro de una imagen de contenedor obliga a arrastrar herramientas de
// compilación a un servidor que está expuesto a internet.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const CARPETA_DATOS = process.env.LAMPARA_DATOS || path.join(__dirname, '..', 'datos');

let db = null;

function abrir(ruta) {
  const archivo = ruta || path.join(CARPETA_DATOS, 'portal.sqlite3');
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  db = new DatabaseSync(archivo);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  crearEsquema();
  return db;
}

function cerrar() {
  if (db) db.close();
  db = null;
}

function crearEsquema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS iglesias (
      id                TEXT PRIMARY KEY,
      nombre            TEXT NOT NULL,
      plan              TEXT NOT NULL DEFAULT 'completo',
      estado            TEXT NOT NULL DEFAULT 'activo',
      vigente_hasta     TEXT,
      contacto_nombre   TEXT DEFAULT '',
      contacto_correo   TEXT DEFAULT '',
      contacto_telefono TEXT DEFAULT '',
      direccion         TEXT DEFAULT '',
      notas             TEXT DEFAULT '',
      creada_en         TEXT NOT NULL,
      actualizada_en    TEXT NOT NULL,
      ultima_revision_en TEXT,
      ultima_ip         TEXT,
      revisiones        INTEGER NOT NULL DEFAULT 0
    );

    -- Qué equipos ha visto el portal. Es lo que permite desmentir a una
    -- instalación que borró sus archivos para volver a empezar: la app puede
    -- perder la memoria, el servidor no.
    CREATE TABLE IF NOT EXISTS equipos (
      huella        TEXT PRIMARY KEY,
      cliente_id    TEXT NOT NULL,
      primera_vez   TEXT NOT NULL,
      ultima_vez    TEXT NOT NULL,
      revisiones    INTEGER NOT NULL DEFAULT 0,
      version_app   TEXT DEFAULT '',
      ultima_ip     TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_equipos_cliente ON equipos (cliente_id);

    CREATE TABLE IF NOT EXISTS bitacora (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id TEXT,
      cuando     TEXT NOT NULL,
      tipo       TEXT NOT NULL,
      detalle    TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_bitacora_cliente ON bitacora (cliente_id, id DESC);
  `);
}

const ahora = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Identificadores
// ---------------------------------------------------------------------------

/**
 * Arma el identificador de una iglesia a partir de su nombre.
 *
 * El sufijo aleatorio no es decoración: el archivo de licencia se descarga en
 * `/licencias/{id}` sin contraseña —la app no tiene ninguna que dar— así que un
 * id adivinable como "templo-restauracion" dejaría que cualquiera se bajase la
 * licencia ajena y usara Lámpara con ella. Con seis hexadecimales al final ya
 * no hay nada que adivinar, y no hizo falta tocar la app para conseguirlo.
 */
function generarId(nombre) {
  const base = String(nombre || 'iglesia')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // los acentos, ya separados por NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'iglesia';
  return base + '-' + crypto.randomBytes(3).toString('hex');
}

// ---------------------------------------------------------------------------
// Iglesias
// ---------------------------------------------------------------------------

function iglesias() {
  return db.prepare('SELECT * FROM iglesias ORDER BY nombre COLLATE NOCASE').all();
}

function iglesia(id) {
  return db.prepare('SELECT * FROM iglesias WHERE id = ?').get(id) || null;
}

function crearIglesia(datos) {
  const id = datos.id || generarId(datos.nombre);
  const cuando = ahora();
  db.prepare(
    `INSERT INTO iglesias (id, nombre, plan, estado, vigente_hasta, contacto_nombre,
       contacto_correo, contacto_telefono, direccion, notas, creada_en, actualizada_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    datos.nombre,
    datos.plan || 'completo',
    datos.estado || 'activo',
    datos.vigenteHasta || null,
    datos.contactoNombre || '',
    datos.contactoCorreo || '',
    datos.contactoTelefono || '',
    datos.direccion || '',
    datos.notas || '',
    cuando,
    cuando
  );
  anotar(id, 'alta', datos.nombre);
  return iglesia(id);
}

function actualizarIglesia(id, datos) {
  db.prepare(
    `UPDATE iglesias SET nombre = ?, plan = ?, contacto_nombre = ?, contacto_correo = ?,
       contacto_telefono = ?, direccion = ?, notas = ?, actualizada_en = ?
     WHERE id = ?`
  ).run(
    datos.nombre,
    datos.plan || 'completo',
    datos.contactoNombre || '',
    datos.contactoCorreo || '',
    datos.contactoTelefono || '',
    datos.direccion || '',
    datos.notas || '',
    ahora(),
    id
  );
  anotar(id, 'edicion', 'Se actualizaron los datos');
  return iglesia(id);
}

function cambiarEstado(id, estado, motivo) {
  db.prepare('UPDATE iglesias SET estado = ?, actualizada_en = ? WHERE id = ?').run(estado, ahora(), id);
  anotar(id, 'cambio_estado', estado + (motivo ? ' — ' + motivo : ''));
  return iglesia(id);
}

/**
 * Extiende la vigencia.
 *
 * Cuenta desde hoy o desde el vencimiento actual, lo que sea más tarde: renovar
 * antes de tiempo no le puede quitar días a quien pagó puntual.
 */
function renovar(id, meses, desde = Date.now()) {
  const actual = iglesia(id);
  if (!actual) throw new Error('No existe la iglesia ' + id);

  const vencimiento = actual.vigente_hasta ? new Date(actual.vigente_hasta).getTime() : 0;
  const arranque = new Date(Math.max(desde, isNaN(vencimiento) ? 0 : vencimiento));
  const nuevo = new Date(arranque);
  nuevo.setMonth(nuevo.getMonth() + Number(meses));

  db.prepare('UPDATE iglesias SET vigente_hasta = ?, actualizada_en = ? WHERE id = ?')
    .run(nuevo.toISOString(), ahora(), id);
  anotar(id, 'renovacion', '+' + meses + ' mes(es), hasta ' + nuevo.toISOString().slice(0, 10));
  return iglesia(id);
}

function eliminarIglesia(id) {
  db.prepare('DELETE FROM iglesias WHERE id = ?').run(id);
  anotar(id, 'baja', 'Se eliminó la iglesia');
}

/** Deja constancia de que la app de esa iglesia pasó a buscar su licencia. */
function anotarRevision(id, ip) {
  db.prepare(
    'UPDATE iglesias SET ultima_revision_en = ?, ultima_ip = ?, revisiones = revisiones + 1 WHERE id = ?'
  ).run(ahora(), ip || '', id);
}

// ---------------------------------------------------------------------------
// Equipos
// ---------------------------------------------------------------------------

/**
 * Anota que este equipo pidió licencia y devuelve lo que el portal ya sabía
 * de él.
 *
 * `primera_vez` es el dato valioso y por eso nunca se pisa: es la fecha real en
 * que ese equipo empezó su prueba, y es lo único que sobrevive a que alguien
 * borre `%APPDATA%\Lampara` para volver a tener treinta días. La app puede
 * perder la memoria; esta fila no.
 *
 * Si el equipo cambia de cliente —la iglesia terminó la prueba y compró— se
 * actualiza a quién pertenece, pero la fecha original se conserva igual.
 */
function registrarEquipo(huella, clienteId, { ip = '', version = '' } = {}) {
  const cuando = ahora();
  const previo = db.prepare('SELECT * FROM equipos WHERE huella = ?').get(huella) || null;

  if (previo) {
    db.prepare(
      'UPDATE equipos SET cliente_id = ?, ultima_vez = ?, revisiones = revisiones + 1, version_app = ?, ultima_ip = ? WHERE huella = ?'
    ).run(clienteId, cuando, version, ip, huella);
  } else {
    db.prepare(
      'INSERT INTO equipos (huella, cliente_id, primera_vez, ultima_vez, revisiones, version_app, ultima_ip) VALUES (?, ?, ?, ?, 1, ?, ?)'
    ).run(huella, clienteId, cuando, cuando, version, ip);
  }

  return {
    registro: db.prepare('SELECT * FROM equipos WHERE huella = ?').get(huella),
    conocido: Boolean(previo),
  };
}

function equiposDe(clienteId) {
  return db.prepare('SELECT * FROM equipos WHERE cliente_id = ? ORDER BY ultima_vez DESC').all(clienteId);
}

// ---------------------------------------------------------------------------
// Bitácora
// ---------------------------------------------------------------------------

function anotar(clienteId, tipo, detalle) {
  db.prepare('INSERT INTO bitacora (cliente_id, cuando, tipo, detalle) VALUES (?, ?, ?, ?)')
    .run(clienteId, ahora(), tipo, detalle || '');
}

function historial(clienteId, limite = 40) {
  return db.prepare('SELECT * FROM bitacora WHERE cliente_id = ? ORDER BY id DESC LIMIT ?')
    .all(clienteId, limite);
}

module.exports = {
  CARPETA_DATOS,
  abrir,
  cerrar,
  generarId,
  iglesias,
  iglesia,
  crearIglesia,
  actualizarIglesia,
  cambiarEstado,
  renovar,
  eliminarIglesia,
  anotarRevision,
  registrarEquipo,
  equiposDe,
  anotar,
  historial,
};
