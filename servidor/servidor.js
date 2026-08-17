// Portal de licencias de Lámpara.
//
// Dos superficies muy distintas en el mismo proceso:
//
//   GET /licencias/{clienteId}   público, sin contraseña — lo llama la app de
//                                cada iglesia al arrancar. Devuelve un archivo
//                                firmado nuevo con 30 días de autonomía.
//   /admin/...                   el panel, detrás de contraseña.
//
// Lo que este servidor NO hace es igual de importante: no decide si la app deja
// proyectar. Eso lo decide la app leyendo la firma. Aunque alguien tumbe o
// suplante este servidor, sin la clave privada no puede fabricar una licencia
// que la app acepte, y si simplemente no responde, las iglesias siguen
// proyectando con el archivo que ya tienen.
'use strict';

const http = require('http');
const { URL } = require('url');

const db = require('./db');
const licencias = require('./licencias');
const sesion = require('./sesion');
const admin = require('./admin');
const { pagina, escapar } = require('./plantilla');

const PUERTO = Number(process.env.PORT || 8099);
const HOST = process.env.HOST || '0.0.0.0';

/** La dirección por la que llegan las iglesias; solo se usa para mostrarla. */
const URL_PUBLICA = (process.env.LAMPARA_URL_PUBLICA || 'http://localhost:' + PUERTO).replace(/\/+$/, '');

const CLAVE_ADMIN_HASH = process.env.LAMPARA_ADMIN_CLAVE_HASH || '';

/**
 * Lee un interruptor de entorno.
 *
 * Acepta tanto la forma en español como la que escribiría cualquiera que venga
 * de Docker: quien configure esto va a poner `true` tarde o temprano, y una
 * opción de seguridad que se apaga sola por escribirla en otro idioma —sin
 * error, sin aviso— es una trampa, no una convención.
 */
function afirmativo(valor) {
  return ['si', 'sí', 'true', '1', 'yes'].includes(String(valor || '').trim().toLowerCase());
}

/**
 * Detrás del túnel de Cloudflare, `remoteAddress` siempre es el túnel: sin esto
 * todas las iglesias comparten IP y el límite de peticiones las castiga juntas.
 * Se activa a mano porque creerle a una cabecera que puede falsificar cualquiera
 * cuando *no* hay un proxy delante sería regalarle a cada visitante la
 * posibilidad de elegir su propia identidad ante el limitador.
 */
const CONFIAR_EN_PROXY = afirmativo(process.env.LAMPARA_TRAS_PROXY);

const CUERPO_MAXIMO = 64 * 1024;

// ---------------------------------------------------------------------------
// Utilidades de petición
// ---------------------------------------------------------------------------

function ipDe(req) {
  if (CONFIAR_EN_PROXY) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf);
    const reenviada = req.headers['x-forwarded-for'];
    if (reenviada) return String(reenviada).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let datos = '';
    req.on('data', (trozo) => {
      datos += trozo;
      if (datos.length > CUERPO_MAXIMO) {
        reject(new Error('cuerpo demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(datos));
    req.on('error', reject);
  });
}

async function formulario(req) {
  const parametros = new URLSearchParams(await leerCuerpo(req));
  const objeto = {};
  for (const [clave, valor] of parametros) objeto[clave] = valor;
  return objeto;
}

function responder(res, codigo, cuerpo, cabeceras = {}) {
  res.writeHead(codigo, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // El panel no carga nada de fuera: ni scripts, ni tipografías, ni imágenes
    // remotas. Declararlo cierra de golpe cualquier inyección que se cuele.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    ...cabeceras,
  });
  res.end(cuerpo);
}

function redirigir(res, destino, cabeceras = {}) {
  res.writeHead(302, { Location: destino, ...cabeceras });
  res.end();
}

// ---------------------------------------------------------------------------
// Límite de peticiones del extremo público
// ---------------------------------------------------------------------------
// La app consulta una vez por arranque. Cualquiera que pida decenas de veces
// por minuto está probando identificadores, no proyectando un culto.

const VENTANA_MS = 60 * 1000;
const PETICIONES_POR_VENTANA = 20;
const contadores = new Map();

function demasiadas(ip) {
  const ahora = Date.now();
  const registro = contadores.get(ip);
  if (!registro || ahora > registro.hasta) {
    contadores.set(ip, { cuenta: 1, hasta: ahora + VENTANA_MS });
    return false;
  }
  registro.cuenta += 1;
  return registro.cuenta > PETICIONES_POR_VENTANA;
}

/** Solo para las pruebas, que saturan el límite a propósito y siguen usando el portal. */
function reiniciarLimite() {
  contadores.clear();
}

// Sin esto, el mapa crece con cada IP que toque el portal y no se vacía nunca.
setInterval(() => {
  const ahora = Date.now();
  for (const [ip, registro] of contadores) if (ahora > registro.hasta) contadores.delete(ip);
}, 5 * VENTANA_MS).unref();

// ---------------------------------------------------------------------------
// Extremo público: la licencia
// ---------------------------------------------------------------------------

/**
 * Emite el archivo vigente de una iglesia.
 *
 * Se firma uno nuevo en cada consulta en vez de guardar el último: así la
 * ventana de 30 días se renueva sola con cada arranque de la app, y un cambio
 * de estado en el panel llega a la iglesia la próxima vez que abra Lámpara sin
 * que nadie tenga que reenviar nada.
 */
function licenciaDe(iglesia) {
  return licencias.emitir({
    clienteId: iglesia.id,
    nombreCliente: iglesia.nombre,
    estado: iglesia.estado,
    plan: iglesia.plan,
    vigenteHasta: iglesia.vigente_hasta,
  });
}

/**
 * La prueba, contada por el servidor y no por el equipo.
 *
 * Todas las instalaciones nuevas comparten este mismo cliente, así que lo que
 * distingue una prueba de otra es la huella del equipo. Y ahí está el punto:
 * la fecha de inicio la pone el portal la primera vez que ve esa huella, y
 * borrar `%APPDATA%\Lampara` —o reinstalar Lámpara entera— ya no la mueve.
 *
 * Se emite `validoHasta` como fecha absoluta y **sin** `diasPrueba`: ese campo
 * le diría a la app que vuelva a contar por su cuenta desde el primer arranque
 * local, que es justo lo que aquí se quiere dejar de hacer.
 */
function licenciaDePrueba(registro) {
  const inicio = new Date(registro.primera_vez).getTime();
  return licencias.emitir({
    clienteId: licencias.CLIENTE_PRUEBA,
    nombreCliente: 'Período de prueba',
    estado: 'activo',
    plan: 'prueba',
    vigenteHasta: new Date(inicio + licencias.DIAS_PRUEBA * licencias.MS_DIA).toISOString(),
  });
}

function servirLicencia(req, res, clienteId, url) {
  const ip = ipDe(req);
  if (demasiadas(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: 'demasiadas peticiones' }));
    return;
  }

  // La huella es opcional: una app anterior a esto no la manda y tiene que
  // seguir recibiendo su licencia igual. Se acota el largo porque va derecha a
  // la base de datos.
  const huella = String(url.searchParams.get('equipo') || '').slice(0, 128);
  const version = String(url.searchParams.get('version') || '').slice(0, 32);

  const esPrueba = clienteId === licencias.CLIENTE_PRUEBA;
  const iglesia = esPrueba ? null : db.iglesia(clienteId);

  if (!esPrueba && !iglesia) {
    // Mismo cuerpo y mismo código para un id inexistente que para uno mal
    // escrito: no se confirma cuáles existen.
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'no encontrada' }));
    return;
  }

  let anotado = null;
  if (huella) anotado = db.registrarEquipo(huella, clienteId, { ip, version });

  let texto;
  if (esPrueba) {
    // Sin huella no hay nada que anclar: se le dan sus 30 días desde hoy, que
    // es exactamente lo que hacía la app sola antes de que el portal existiera.
    texto = anotado
      ? licenciaDePrueba(anotado.registro).texto
      : licencias.emitir({
          clienteId: licencias.CLIENTE_PRUEBA,
          nombreCliente: 'Período de prueba',
          plan: 'prueba',
          vigenteHasta: null,
        }).texto;
  } else {
    // --- Cuántas computadoras puede usar esta iglesia -------------------------
    // Los equipos van tomando las licencias libres al conectarse; cuando no
    // quedan, el que llega tarde se bloquea. No se toca el estado de la cuenta
    // en la base —eso sigue diciendo "activo" para los equipos que sí tienen
    // licencia— se firma una respuesta aparte, solo para él, que la app
    // entiende como bloqueo. Sin huella (una app anterior a esto) no hay nada
    // que exigir: se sirve igual, como antes de que esto existiera.
    let denegadoPorEquipo = false;
    if (huella && anotado && !anotado.registro.autorizado) {
      if (anotado.registro.bloqueado) {
        // Dado de baja a propósito: no vuelve a tomar una licencia solo aunque
        // haya libres. Para eso está el botón de autorizar en el panel.
        denegadoPorEquipo = true;
      } else if (db.equiposAutorizados(iglesia.id) < iglesia.equipos_permitidos) {
        db.autorizarEquipo(iglesia.id, huella, { automatico: true });
      } else {
        denegadoPorEquipo = true;
        db.anotar(
          iglesia.id,
          'equipo_rechazado',
          'Un equipo más pidió licencia y ya están ocupadas las ' + iglesia.equipos_permitidos
        );
      }
    }

    texto = denegadoPorEquipo
      ? licencias.emitir({
          clienteId: iglesia.id,
          nombreCliente: iglesia.nombre,
          estado: 'otro_equipo',
          plan: iglesia.plan,
          vigenteHasta: iglesia.vigente_hasta,
        }).texto
      : licenciaDe(iglesia).texto;

    db.anotarRevision(iglesia.id, ip);
  }

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(texto);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function sesionDe(req) {
  const token = sesion.leerCookie(req.headers.cookie, sesion.NOMBRE_COOKIE);
  return token ? sesion.sesionValida(token) : null;
}

const esSeguro = (req) => URL_PUBLICA.startsWith('https://') || String(req.headers['x-forwarded-proto']) === 'https';

async function manejarAdmin(req, res, ruta, url) {
  const ses = sesionDe(req);

  // --- Entrar / salir -------------------------------------------------------
  if (ruta === '/admin/entrar') {
    if (ses) return redirigir(res, '/admin');

    if (req.method === 'GET') {
      return responder(res, 200, admin.vistaEntrar({ espera: sesion.castigada(ipDe(req)) }));
    }

    const ip = ipDe(req);
    const espera = sesion.castigada(ip);
    if (espera) return responder(res, 429, admin.vistaEntrar({ espera }));

    if (!CLAVE_ADMIN_HASH) {
      return responder(
        res,
        500,
        admin.vistaEntrar({ error: 'El portal no tiene contraseña configurada. Falta LAMPARA_ADMIN_CLAVE_HASH.' })
      );
    }

    const datos = await formulario(req);
    if (!sesion.claveCorrecta(datos.clave || '', CLAVE_ADMIN_HASH)) {
      sesion.anotarFallo(ip);
      return responder(res, 401, admin.vistaEntrar({ error: 'Contraseña incorrecta.' }));
    }

    sesion.limpiarFallos(ip);
    const token = sesion.abrirSesion();
    return redirigir(res, '/admin', { 'Set-Cookie': sesion.cabeceraCookie(token, { seguro: esSeguro(req) }) });
  }

  if (!ses) return redirigir(res, '/admin/entrar');

  // A partir de aquí hay sesión: todo POST tiene que traer el token del
  // formulario, o sería suficiente con que el administrador visitara otra
  // página para que esa página suspendiera iglesias en su nombre.
  let datos = {};
  if (req.method === 'POST') {
    datos = await formulario(req);
    if (!sesion.csrfCorrecto(ses, datos.csrf)) {
      return responder(res, 403, pagina({ titulo: 'Sesión', contenido: '<h1>Formulario vencido</h1><p><a href="/admin">Volver</a></p>' }));
    }
  }

  if (ruta === '/admin/salir' && req.method === 'POST') {
    sesion.cerrarSesion(sesion.leerCookie(req.headers.cookie, sesion.NOMBRE_COOKIE));
    return redirigir(res, '/admin/entrar', { 'Set-Cookie': sesion.cabeceraCookieBorrada() });
  }

  if (ruta === '/admin' || ruta === '/admin/') {
    return responder(res, 200, admin.vistaLista(ses));
  }

  // --- Alta -----------------------------------------------------------------
  if (ruta === '/admin/nueva') {
    if (req.method === 'GET') return responder(res, 200, admin.vistaNueva(ses));

    if (!String(datos.nombre || '').trim()) {
      return responder(res, 400, admin.vistaNueva(ses, 'La iglesia necesita un nombre.'));
    }
    const creada = db.crearIglesia({
      nombre: datos.nombre.trim(),
      contactoNombre: datos.contactoNombre,
      contactoCorreo: datos.contactoCorreo,
      contactoTelefono: datos.contactoTelefono,
      direccion: datos.direccion,
      notas: datos.notas,
    });
    // Nace con un mes: si quedara sin vigencia, la primera licencia que se
    // descargue ya saldría vencida y la iglesia no podría ni empezar.
    db.renovar(creada.id, 1);
    return redirigir(res, '/admin/iglesias/' + creada.id + '?mensaje=alta');
  }

  // --- Ficha ----------------------------------------------------------------
  const partes = ruta.split('/').filter(Boolean); // admin, iglesias, :id, [accion]
  if (partes[1] !== 'iglesias' || !partes[2]) {
    return responder(res, 404, pagina({ titulo: 'No encontrado', sesion: ses, contenido: '<h1>Página no encontrada</h1>' }));
  }

  const id = decodeURIComponent(partes[2]);
  const iglesia = db.iglesia(id);
  if (!iglesia) {
    return responder(res, 404, pagina({ titulo: 'No encontrada', sesion: ses, contenido: '<h1>Esa iglesia no existe</h1><p><a href="/admin">Volver</a></p>' }));
  }

  const accion = partes[3] || '';

  if (accion === 'licencia.json') {
    const { texto } = licenciaDe(iglesia);
    db.anotar(iglesia.id, 'descarga_manual', 'Se descargó desde el panel');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="licencia.json"',
    });
    return res.end(texto);
  }

  if (req.method === 'POST') {
    if (accion === 'renovar') {
      db.renovar(iglesia.id, Number(datos.meses || 1));
      return redirigir(res, '/admin/iglesias/' + iglesia.id + '?mensaje=renovada');
    }
    if (accion === 'estado') {
      if (!licencias.ESTADOS.includes(datos.estado)) {
        return responder(res, 400, pagina({ titulo: 'Estado', sesion: ses, contenido: '<h1>Estado desconocido</h1>' }));
      }
      db.cambiarEstado(iglesia.id, datos.estado);
      return redirigir(res, '/admin/iglesias/' + iglesia.id + '?mensaje=estado');
    }
    if (accion === 'licencias') {
      const n = db.cambiarEquiposPermitidos(iglesia.id, datos.equipos);
      return redirigir(res, '/admin/iglesias/' + iglesia.id + '?mensaje=licencias&n=' + n);
    }
    if (accion === 'autorizar-equipo' || accion === 'revocar-equipo') {
      const huella = String(datos.huella || '').trim();
      if (!huella) {
        return responder(res, 400, pagina({ titulo: 'Equipo', sesion: ses, contenido: '<h1>Falta el equipo</h1>' }));
      }
      if (accion === 'revocar-equipo') {
        db.revocarEquipo(iglesia.id, huella);
        return redirigir(res, '/admin/iglesias/' + iglesia.id + '?mensaje=revocado');
      }
      // Autorizar a mano respeta el número de licencias en vez de saltárselo:
      // si no, el número dejaría de querer decir nada y se acabaría vendiendo
      // una licencia que en realidad son tres.
      if (db.equiposAutorizados(iglesia.id) >= iglesia.equipos_permitidos) {
        return responder(res, 200, admin.vistaDetalle(ses, iglesia, URL_PUBLICA, null, 'lleno'));
      }
      db.autorizarEquipo(iglesia.id, huella);
      return redirigir(res, '/admin/iglesias/' + iglesia.id + '?mensaje=autorizado');
    }
    if (accion === 'eliminar') {
      db.eliminarIglesia(iglesia.id);
      return redirigir(res, '/admin');
    }
    if (!accion) {
      if (!String(datos.nombre || '').trim()) {
        return responder(res, 400, admin.vistaDetalle(ses, iglesia, URL_PUBLICA, 'La iglesia necesita un nombre.'));
      }
      db.actualizarIglesia(iglesia.id, {
        nombre: datos.nombre.trim(),
        plan: iglesia.plan,
        contactoNombre: datos.contactoNombre,
        contactoCorreo: datos.contactoCorreo,
        contactoTelefono: datos.contactoTelefono,
        direccion: datos.direccion,
        notas: datos.notas,
      });
      return redirigir(res, '/admin/iglesias/' + iglesia.id + '?mensaje=guardada');
    }
  }

  const mensajes = {
    alta: 'Iglesia dada de alta con un mes de vigencia.',
    renovada: 'Vigencia extendida.',
    estado: 'Estado de cuenta actualizado. La app lo verá la próxima vez que arranque.',
    guardada: 'Datos guardados.',
    autorizado: 'Equipo autorizado. La próxima vez que abran Lámpara ahí, proyectará normal.',
    revocado: 'Equipo dado de baja. Dejará de proyectar la próxima vez que se conecte, y su licencia queda libre para otro.',
    licencias: 'Ahora esta iglesia puede usar ' + (url.searchParams.get('n') || '1') + ' computadora(s).',
  };
  return responder(res, 200, admin.vistaDetalle(ses, iglesia, URL_PUBLICA, mensajes[url.searchParams.get('mensaje')]));
}

// ---------------------------------------------------------------------------
// Enrutado
// ---------------------------------------------------------------------------

async function manejar(req, res) {
  const url = new URL(req.url, 'http://interno');
  const ruta = url.pathname.replace(/\/+$/, '') || '/';

  if (ruta === '/salud') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, iglesias: db.iglesias().length }));
  }

  if (ruta.startsWith('/licencias/') && req.method === 'GET') {
    return servirLicencia(req, res, decodeURIComponent(ruta.slice('/licencias/'.length)), url);
  }

  if (ruta.startsWith('/admin')) return manejarAdmin(req, res, ruta, url);

  if (ruta === '/') return redirigir(res, '/admin');

  return responder(res, 404, pagina({ titulo: 'No encontrado', contenido: '<h1>Página no encontrada</h1>' }));
}

function crearServidor() {
  return http.createServer((req, res) => {
    manejar(req, res).catch((e) => {
      // El detalle va al registro del servidor, no al navegador: un mensaje de
      // error de SQLite le cuenta a un desconocido cómo está hecho esto por
      // dentro.
      console.error('[portal]', req.method, req.url, e);
      if (!res.headersSent) responder(res, 500, pagina({ titulo: 'Error', contenido: '<h1>Algo salió mal</h1>' }));
      else res.end();
    });
  });
}

function arrancar() {
  db.abrir();

  if (!CLAVE_ADMIN_HASH) {
    console.warn('[portal] AVISO: no hay LAMPARA_ADMIN_CLAVE_HASH — el panel no dejará entrar a nadie.');
    console.warn('[portal] Genera una con: npm run clave-admin');
  }
  if (!licencias.clavePublicaPem()) {
    console.warn('[portal] AVISO: no hay clave de firma. Genérala con: npm run claves');
  }

  const servidor = crearServidor();
  servidor.listen(PUERTO, HOST, () => {
    console.log('Portal de Lámpara escuchando en http://' + HOST + ':' + PUERTO);
    console.log('Dirección pública: ' + URL_PUBLICA);
  });

  const cerrar = () => {
    servidor.close(() => {
      db.cerrar();
      process.exit(0);
    });
  };
  process.on('SIGTERM', cerrar);
  process.on('SIGINT', cerrar);

  return servidor;
}

if (require.main === module) arrancar();

module.exports = { crearServidor, arrancar, licenciaDe, reiniciarLimite, PUERTO };
