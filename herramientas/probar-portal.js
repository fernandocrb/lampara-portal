#!/usr/bin/env node
//
// Prueba del portal de punta a punta: levanta el servidor de verdad sobre una
// base temporal y lo interroga por HTTP, igual que lo harán la app y el
// navegador.
//
//   npm run probar
//
// La comprobación que más importa no es ninguna de las de HTTP: es que el
// archivo emitido siga encajando con lo que verifica `app/lib/licencia.js`.
// Ese contrato está repartido entre dos repos y nadie lo va a notar roto hasta
// que una iglesia se quede sin proyectar un domingo.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Antes de cargar nada del servidor: los módulos leen esta variable al importarse.
const CARPETA = fs.mkdtempSync(path.join(os.tmpdir(), 'lampara-portal-'));
process.env.LAMPARA_DATOS = CARPETA;
process.env.LAMPARA_ADMIN_CLAVE_HASH = '';

const licencias = require('../servidor/licencias');
const sesion = require('../servidor/sesion');
const db = require('../servidor/db');

const CLAVE_PRUEBA = 'contrasena-de-prueba-larga';
process.env.LAMPARA_ADMIN_CLAVE_HASH = sesion.crearHash(CLAVE_PRUEBA);

const servidorModulo = require('../servidor/servidor');

const resultados = [];
function anotar(paso, ok, detalle) {
  resultados.push(ok);
  console.log((ok ? '  OK   ' : '  FALLA') + ' | ' + paso + (detalle ? ' — ' + detalle : ''));
}

const RUTA_APP = path.join(__dirname, '..', '..', 'lampara', 'app', 'lib', 'licencia.js');

/**
 * Borra la carpeta temporal sin hacer ruido. En Windows, si la prueba se cortó
 * a media asada la base puede seguir abierta y el borrado da EPERM: eso no es
 * un fallo de la prueba, es basura en %TEMP%.
 */
function limpiar() {
  try {
    fs.rmSync(CARPETA, { recursive: true, force: true });
  } catch (e) {
    console.warn('(quedó sin borrar la carpeta temporal ' + CARPETA + ')');
  }
}

async function principal() {
  // --- 1. Claves ------------------------------------------------------------
  licencias.generarClaves();
  anotar('genera el par de firma', Boolean(licencias.clavePublicaPem()));

  let protegida = false;
  try {
    licencias.generarClaves();
  } catch (e) {
    protegida = true;
  }
  anotar('se niega a regenerar la clave sin --forzar', protegida);

  // --- 2. El formato que espera la app --------------------------------------
  const emitida = licencias.emitir({ clienteId: 'x-1', nombreCliente: 'Iglesia X', vigenteHasta: null });
  const sobre = JSON.parse(emitida.texto);

  anotar('el sobre trae formato, payload y firma', Boolean(sobre.formato && sobre.payload && sobre.firma));

  // Se verifica exactamente como lo hace la app: sobre los bytes del payload en
  // base64url, no sobre el objeto reconstruido.
  const clave = crypto.createPublicKey(licencias.clavePublicaPem());
  anotar(
    'la firma cubre los bytes del payload',
    crypto.verify(null, Buffer.from(sobre.payload, 'utf8'), clave, Buffer.from(sobre.firma, 'base64'))
  );

  const datos = JSON.parse(Buffer.from(sobre.payload, 'base64url').toString('utf8'));
  const camposApp = ['clienteId', 'nombreCliente', 'estado', 'plan', 'emitidaEn', 'validoHasta'];
  anotar(
    'el payload trae los campos que lee la app',
    camposApp.every((c) => c in datos),
    camposApp.filter((c) => !(c in datos)).join(', ') || 'todos'
  );

  // Reindentar el JSON del sobre no puede invalidar nada: la firma va sobre el
  // payload, no sobre el archivo.
  const reindentado = JSON.stringify(sobre, null, 8);
  anotar('reindentar el archivo no invalida la firma', licencias.verificar(reindentado).valido);

  // Y alterar el contenido sí tiene que romperla.
  const alterado = { ...datos, validoHasta: '2099-01-01T00:00:00.000Z' };
  const sobreAlterado = JSON.stringify({
    formato: sobre.formato,
    payload: Buffer.from(JSON.stringify(alterado)).toString('base64url'),
    firma: sobre.firma,
  });
  anotar('una licencia alterada no verifica', !licencias.verificar(sobreAlterado).valido);

  // El contrato vive en dos repos. Si alguien cambia el nombre del formato en
  // uno, esto lo dice ahora y no el domingo.
  if (fs.existsSync(RUTA_APP)) {
    const fuenteApp = fs.readFileSync(RUTA_APP, 'utf8');
    const coincide = new RegExp("FORMATO\\s*=\\s*'" + licencias.FORMATO + "'").test(fuenteApp);
    anotar('el formato coincide con el de la app', coincide, licencias.FORMATO);
  } else {
    anotar('el formato coincide con el de la app', true, 'omitida: no está el repo de la app al lado');
  }

  // --- 3. Los dos relojes ---------------------------------------------------
  const ahora = Date.parse('2026-03-01T12:00:00Z');
  const lejos = licencias.calcularValidoHasta('2027-01-01T00:00:00.000Z', ahora);
  anotar(
    'con la cuota pagada de sobra, el archivo vale 30 días',
    Math.round((Date.parse(lejos) - ahora) / licencias.MS_DIA) === 30,
    lejos.slice(0, 10)
  );

  const cerca = '2026-03-10T00:00:00.000Z';
  anotar('si la cuota vence antes, manda la cuota', licencias.calcularValidoHasta(cerca, ahora) === cerca);

  // --- 4. Servidor ----------------------------------------------------------
  db.abrir();
  const servidor = servidorModulo.crearServidor();
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
  const base = 'http://127.0.0.1:' + servidor.address().port;

  const iglesia = db.crearIglesia({ nombre: 'Templo de Prueba', contactoNombre: 'Allyson' });
  db.renovar(iglesia.id, 12);

  anotar('el identificador no es adivinable', /-[0-9a-f]{6}$/.test(iglesia.id), iglesia.id);

  const publica = await fetch(base + '/licencias/' + iglesia.id);
  const textoPublico = await publica.text();
  anotar('sirve la licencia por HTTP', publica.status === 200 && licencias.verificar(textoPublico).valido);

  anotar(
    'anota la conexión de la iglesia',
    Boolean(db.iglesia(iglesia.id).ultima_revision_en),
    db.iglesia(iglesia.id).revisiones + ' revisión(es)'
  );

  const inexistente = await fetch(base + '/licencias/no-existe-000000');
  anotar('404 para un identificador desconocido', inexistente.status === 404);

  // --- 5. El estado de cuenta llega a la app --------------------------------
  db.cambiarEstado(iglesia.id, 'moroso');
  const morosa = licencias.verificar(await (await fetch(base + '/licencias/' + iglesia.id)).text());
  anotar('marcar morosa cambia lo que se emite', morosa.datos.estado === 'moroso');
  db.cambiarEstado(iglesia.id, 'activo');

  // --- 6. Límite de peticiones ----------------------------------------------
  let bloqueado = false;
  for (let i = 0; i < 30 && !bloqueado; i++) {
    const r = await fetch(base + '/licencias/' + iglesia.id);
    if (r.status === 429) bloqueado = true;
  }
  anotar('frena a quien prueba identificadores en masa', bloqueado);
  // Todo lo que sigue sale de la misma IP y quedaría castigado por lo anterior.
  servidorModulo.reiniciarLimite();

  // --- 7. Panel -------------------------------------------------------------
  const sinSesion = await fetch(base + '/admin', { redirect: 'manual' });
  anotar('el panel no se abre sin entrar', sinSesion.status === 302 && sinSesion.headers.get('location') === '/admin/entrar');

  const cuerpoLogin = (clave) => new URLSearchParams({ clave }).toString();
  const cabecerasForm = { 'Content-Type': 'application/x-www-form-urlencoded' };

  const mala = await fetch(base + '/admin/entrar', { method: 'POST', headers: cabecerasForm, body: cuerpoLogin('otra-cosa'), redirect: 'manual' });
  anotar('rechaza la contraseña incorrecta', mala.status === 401);

  const buena = await fetch(base + '/admin/entrar', { method: 'POST', headers: cabecerasForm, body: cuerpoLogin(CLAVE_PRUEBA), redirect: 'manual' });
  const galleta = (buena.headers.get('set-cookie') || '').split(';')[0];
  anotar('deja entrar con la contraseña correcta', buena.status === 302 && galleta.startsWith(sesion.NOMBRE_COOKIE + '='));

  anotar('la cookie de sesión no se lee desde el navegador', /HttpOnly/i.test(buena.headers.get('set-cookie') || ''));

  const conSesion = { Cookie: galleta };
  const lista = await fetch(base + '/admin', { headers: conSesion });
  const htmlLista = await lista.text();
  anotar('la lista muestra la iglesia', lista.status === 200 && htmlLista.includes('Templo de Prueba'));

  // El token CSRF sale del propio HTML, igual que lo enviaría el navegador.
  const ficha = await (await fetch(base + '/admin/iglesias/' + iglesia.id, { headers: conSesion })).text();
  const csrf = (ficha.match(/name="csrf" value="([^"]+)"/) || [])[1];
  anotar('la ficha trae un token de formulario', Boolean(csrf));

  const sinToken = await fetch(base + '/admin/iglesias/' + iglesia.id + '/estado', {
    method: 'POST',
    headers: { ...cabecerasForm, ...conSesion },
    body: new URLSearchParams({ estado: 'suspendido' }).toString(),
    redirect: 'manual',
  });
  anotar(
    'un formulario sin token no suspende a nadie',
    sinToken.status === 403 && db.iglesia(iglesia.id).estado === 'activo'
  );

  const conToken = await fetch(base + '/admin/iglesias/' + iglesia.id + '/estado', {
    method: 'POST',
    headers: { ...cabecerasForm, ...conSesion },
    body: new URLSearchParams({ estado: 'suspendido', csrf }).toString(),
    redirect: 'manual',
  });
  anotar('con token sí', conToken.status === 302 && db.iglesia(iglesia.id).estado === 'suspendido');

  // --- 8. Renovar no le quita días a quien pagó puntual ---------------------
  const antes = new Date(db.iglesia(iglesia.id).vigente_hasta).getTime();
  db.renovar(iglesia.id, 1);
  const despues = new Date(db.iglesia(iglesia.id).vigente_hasta).getTime();
  anotar('renovar antes de tiempo suma, no reemplaza', despues > antes);

  // --- 9. El nombre de la iglesia no puede ser HTML -------------------------
  const traviesa = db.crearIglesia({ nombre: '<script>alert(1)</script>' });
  const htmlConTraviesa = await (await fetch(base + '/admin', { headers: conSesion })).text();
  anotar(
    'un nombre con HTML se muestra escapado',
    !htmlConTraviesa.includes('<script>alert(1)</script>') && htmlConTraviesa.includes('&lt;script&gt;')
  );
  db.eliminarIglesia(traviesa.id);

  // --- 10. La prueba la cuenta el servidor, no el equipo --------------------
  // Esto es lo que cierra el agujero de borrar %APPDATA%\Lampara para volver a
  // tener treinta días.
  const HUELLA = crypto.createHash('sha256').update('equipo-de-prueba').digest('hex');
  const urlPrueba = base + '/licencias/' + licencias.CLIENTE_PRUEBA + '?equipo=' + HUELLA;

  const primera = licencias.verificar(await (await fetch(urlPrueba)).text());
  const diasIniciales = Math.round((Date.parse(primera.datos.validoHasta) - Date.now()) / licencias.MS_DIA);
  anotar(
    'un equipo nuevo estrena 30 días de prueba',
    primera.datos.plan === 'prueba' && diasIniciales === 30,
    diasIniciales + ' días'
  );

  anotar(
    'la prueba del servidor no manda diasPrueba',
    !('diasPrueba' in primera.datos),
    'si lo mandara, la app volvería a contar por su cuenta'
  );

  // Se envejece la huella a mano: es lo mismo que ver al equipo 25 días después.
  const { DatabaseSync } = require('node:sqlite');
  const baseDirecta = new DatabaseSync(path.join(CARPETA, 'portal.sqlite3'));
  const envejecer = (dias) =>
    baseDirecta
      .prepare('UPDATE equipos SET primera_vez = ? WHERE huella = ?')
      .run(new Date(Date.now() - dias * licencias.MS_DIA).toISOString(), HUELLA);

  envejecer(25);
  const reinstalada = licencias.verificar(await (await fetch(urlPrueba)).text());
  const quedan = Math.round((Date.parse(reinstalada.datos.validoHasta) - Date.now()) / licencias.MS_DIA);
  anotar('reinstalar no devuelve los 30 días', quedan === 5, 'quedan ' + quedan);

  envejecer(40);
  const agotada = licencias.verificar(await (await fetch(urlPrueba)).text());
  anotar(
    'una prueba vieja llega vencida aunque el equipo se haya borrado',
    Date.parse(agotada.datos.validoHasta) < Date.now(),
    agotada.datos.validoHasta.slice(0, 10)
  );
  baseDirecta.close();

  // Una app anterior a esto no manda huella y no se puede quedar sin servicio.
  const sinHuella = licencias.verificar(await (await fetch(base + '/licencias/' + licencias.CLIENTE_PRUEBA)).text());
  anotar(
    'sin huella, la prueba sigue funcionando como antes',
    Math.round((Date.parse(sinHuella.datos.validoHasta) - Date.now()) / licencias.MS_DIA) === 30
  );

  // --- 11. Equipos de una iglesia -------------------------------------------
  const HUELLA_IGLESIA = crypto.createHash('sha256').update('equipo-del-templo').digest('hex');
  await fetch(base + '/licencias/' + iglesia.id + '?equipo=' + HUELLA_IGLESIA + '&version=0.1.0');
  const registrados = db.equiposDe(iglesia.id);
  anotar('la ficha de la iglesia registra su equipo', registrados.length === 1 && registrados[0].version_app === '0.1.0');

  anotar(
    'el primer equipo de una iglesia toma una licencia libre solo',
    db.historial(iglesia.id).some((e) => e.tipo === 'equipo_autorizado') && db.equiposAutorizados(iglesia.id) === 1
  );

  // --- 12. Cuántas computadoras puede usar una iglesia -----------------------
  const otra = db.crearIglesia({ nombre: 'Iglesia de un equipo' });
  db.renovar(otra.id, 6);

  const HUELLA_A = crypto.createHash('sha256').update('equipo-a').digest('hex');
  const HUELLA_B = crypto.createHash('sha256').update('equipo-b').digest('hex');
  const licenciaDe = async (huella) =>
    licencias.verificar(await (await fetch(base + '/licencias/' + otra.id + (huella ? '?equipo=' + huella : ''))).text());

  anotar('una iglesia nace con una sola computadora permitida', db.iglesia(otra.id).equipos_permitidos === 1);

  anotar('el primer equipo toma la licencia libre y proyecta', (await licenciaDe(HUELLA_A)).datos.estado === 'activo');
  anotar('el mismo equipo puede volver a preguntar sin problema', (await licenciaDe(HUELLA_A)).datos.estado === 'activo');

  const segundo = await licenciaDe(HUELLA_B);
  // La firma sigue siendo válida: es una licencia real, solo que bloquea.
  anotar('con las licencias ocupadas, el siguiente equipo queda bloqueado', segundo.datos.estado === 'otro_equipo' && segundo.valido);
  anotar('la cuenta sigue activa para los equipos que sí tienen licencia', db.iglesia(otra.id).estado === 'activo');
  anotar('queda anotado en el historial', db.historial(otra.id).some((e) => e.tipo === 'equipo_rechazado'));

  // Sin huella (una app anterior a esto) se sigue sirviendo la licencia normal.
  anotar('sin huella, sigue sirviendo la licencia normal', (await licenciaDe(null)).datos.estado === 'activo');

  // --- El panel manda -------------------------------------------------------
  const fichaOtra = await (await fetch(base + '/admin/iglesias/' + otra.id, { headers: conSesion })).text();
  const csrfOtra = (fichaOtra.match(/name="csrf" value="([^"]+)"/) || [])[1];
  const enviarPanel = (accion, cuerpo) =>
    fetch(base + '/admin/iglesias/' + otra.id + '/' + accion, {
      method: 'POST',
      headers: { ...cabecerasForm, ...conSesion },
      body: new URLSearchParams({ ...cuerpo, csrf: csrfOtra }).toString(),
      redirect: 'manual',
    });

  // Autorizar a mano con todo ocupado no se salta el número: si no, el número
  // dejaría de querer decir nada.
  const lleno = await enviarPanel('autorizar-equipo', { huella: HUELLA_B });
  anotar(
    'no deja autorizar a mano si ya no quedan licencias',
    lleno.status === 200 && (await lleno.text()).includes('Ya están ocupadas') && (await licenciaDe(HUELLA_B)).datos.estado === 'otro_equipo'
  );

  // Subir el número desde el panel es lo que lo desbloquea.
  const subir = await enviarPanel('licencias', { equipos: '2' });
  anotar('el panel cambia cuántas computadoras puede usar', subir.status === 302 && db.iglesia(otra.id).equipos_permitidos === 2);
  anotar('con una licencia más, el segundo equipo ya proyecta', (await licenciaDe(HUELLA_B)).datos.estado === 'activo');
  anotar('y ahora hay dos equipos con licencia', db.equiposAutorizados(otra.id) === 2);

  // Dar de baja libera la licencia sin tocar la cuenta.
  const baja = await enviarPanel('revocar-equipo', { huella: HUELLA_A });
  anotar('dar de baja un equipo lo bloquea', baja.status === 302 && (await licenciaDe(HUELLA_A)).datos.estado === 'otro_equipo');
  anotar('el otro equipo sigue funcionando', (await licenciaDe(HUELLA_B)).datos.estado === 'activo');

  // Y no se recupera solo aprovechando que quedó una libre: darlo de baja
  // tiene que significar algo más que "esperá al próximo arranque".
  anotar(
    'un equipo dado de baja no vuelve a tomar una licencia libre por su cuenta',
    db.equiposAutorizados(otra.id) === 1 && (await licenciaDe(HUELLA_A)).datos.estado === 'otro_equipo'
  );

  // Volver a autorizarlo desde el panel sí lo levanta.
  await enviarPanel('autorizar-equipo', { huella: HUELLA_A });
  anotar('autorizarlo de nuevo desde el panel lo levanta', (await licenciaDe(HUELLA_A)).datos.estado === 'activo');
  await enviarPanel('revocar-equipo', { huella: HUELLA_A });

  // Bajar el número no desconecta a nadie de callado: se ve el exceso y se
  // decide a mano cuál se queda.
  await enviarPanel('licencias', { equipos: '1' });
  anotar(
    'bajar el número no desautoriza a nadie por su cuenta',
    db.iglesia(otra.id).equipos_permitidos === 1 && (await licenciaDe(HUELLA_B)).datos.estado === 'activo'
  );

  anotar('el número no puede quedar en cero ni en negativo', db.cambiarEquiposPermitidos(otra.id, 0) === 1);

  // --- 13. La prueba que viaja en el instalador ------------------------------
  // Es el archivo que más veces se va a instalar de todos: si sale mal, ninguna
  // instalación nueva puede proyectar.
  const paquete = licencias.emitir({
    clienteId: licencias.CLIENTE_PRUEBA,
    nombreCliente: 'Período de prueba',
    plan: 'prueba',
    vigenteHasta: new Date(Date.now() + 365 * licencias.MS_DIA).toISOString(),
    diasPrueba: licencias.DIAS_PRUEBA,
    topeDeGracia: false,
  });
  const diasOferta = Math.round((Date.parse(paquete.datos.validoHasta) - Date.now()) / licencias.MS_DIA);
  anotar(
    'la prueba del instalador no queda capada a los 30 días de gracia',
    diasOferta > 300 && paquete.datos.diasPrueba === 30,
    'oferta ' + diasOferta + ' días, prueba ' + paquete.datos.diasPrueba
  );

  const clavePublica = await fetch(base + '/clave-publica.pem');
  const pem = await clavePublica.text();
  anotar(
    'publica su clave pública para no copiarla a mano',
    clavePublica.status === 200 && pem.includes('BEGIN PUBLIC KEY') && licencias.verificar(paquete.texto, pem).valido
  );

  // --- 14. Descarga manual desde el panel -----------------------------------
  const manual = await fetch(base + '/admin/iglesias/' + iglesia.id + '/licencia.json', { headers: conSesion });
  anotar(
    'el panel entrega el archivo para enviarlo a mano',
    manual.status === 200 &&
      /attachment/.test(manual.headers.get('content-disposition') || '') &&
      licencias.verificar(await manual.text()).valido
  );

  // --- Cierre ---------------------------------------------------------------
  await new Promise((listo) => servidor.close(listo));
  db.cerrar();
  limpiar();

  const ok = resultados.filter(Boolean).length;
  console.log('\n--- ' + ok + '/' + resultados.length + ' comprobaciones correctas ---\n');
  process.exit(ok === resultados.length ? 0 : 1);
}

principal().catch((e) => {
  console.error(e);
  limpiar();
  process.exit(1);
});
