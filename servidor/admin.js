// Panel de administración: dar de alta iglesias, renovarlas, cobrarles o
// cortarles, y descargar el archivo de licencia para mandárselo a mano cuando
// el equipo de la iglesia no tiene internet.
'use strict';

const db = require('./db');
const licencias = require('./licencias');
const sesion = require('./sesion');
const { escapar, pagina } = require('./plantilla');

const MS_DIA = licencias.MS_DIA;

// ---------------------------------------------------------------------------
// Cómo se ve el estado de una iglesia
// ---------------------------------------------------------------------------

/**
 * Traduce los dos relojes (estado de cuenta y fecha pagada) a una sola etiqueta.
 * Lo que se ve aquí es lo mismo que va a ver la iglesia en su banner.
 */
function semaforo(iglesia) {
  if (iglesia.estado === 'suspendido') return { clase: 'malo', texto: 'Suspendida' };
  if (iglesia.estado === 'moroso') return { clase: 'malo', texto: 'Morosa' };
  if (!iglesia.vigente_hasta) return { clase: 'aviso', texto: 'Sin vigencia' };

  const dias = Math.ceil((new Date(iglesia.vigente_hasta).getTime() - Date.now()) / MS_DIA);
  if (!(dias > 0)) return { clase: 'malo', texto: 'Vencida' };
  if (dias <= 15) return { clase: 'aviso', texto: 'Vence en ' + dias + (dias === 1 ? ' día' : ' días') };
  return { clase: 'ok', texto: 'Al día' };
}

function fecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleDateString('es-PA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fechaHora(iso) {
  if (!iso) return 'nunca';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString('es-PA', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Hace legible "hace cuánto" — con esto se ve de un vistazo quién dejó de usar la app. */
function hace(iso) {
  if (!iso) return 'nunca';
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / MS_DIA);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  if (dias < 30) return 'hace ' + dias + ' días';
  const meses = Math.floor(dias / 30);
  return 'hace ' + meses + (meses === 1 ? ' mes' : ' meses');
}

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------

function vistaEntrar({ error, espera }) {
  return pagina({
    titulo: 'Entrar',
    contenido: `
      <div class="entrar">
        <h1>Portal de Lámpara</h1>
        <p class="sub">Administración de licencias · EducaPanama</p>
        ${error ? `<div class="aviso-caja malo">${escapar(error)}</div>` : ''}
        ${espera ? `<div class="aviso-caja malo">Demasiados intentos. Vuelve a probar en ${espera} minutos.</div>` : ''}
        <form method="post" action="/admin/entrar" class="tarjeta">
          <label>Contraseña
            <input type="password" name="clave" autofocus autocomplete="current-password" required>
          </label>
          <button class="primario" type="submit">Entrar</button>
        </form>
      </div>`,
  });
}

function vistaLista(ses) {
  const todas = db.iglesias();

  const filas = todas
    .map((i) => {
      const s = semaforo(i);
      return `<tr>
        <td>
          <a href="/admin/iglesias/${escapar(i.id)}"><strong>${escapar(i.nombre)}</strong></a>
          <div class="id mono">${escapar(i.id)}</div>
        </td>
        <td><span class="etiqueta ${s.clase}">${escapar(s.texto)}</span></td>
        <td class="opcional">${escapar(fecha(i.vigente_hasta))}</td>
        <td class="opcional">${escapar(db.equiposAutorizados(i.id))} / ${escapar(i.equipos_permitidos)}</td>
        <td class="opcional">${escapar(hace(i.ultima_revision_en))}</td>
      </tr>`;
    })
    .join('');

  const activas = todas.filter((i) => semaforo(i).clase === 'ok').length;
  const atencion = todas.filter((i) => semaforo(i).clase === 'malo').length;

  return pagina({
    titulo: 'Iglesias',
    sesion: ses,
    activo: 'iglesias',
    contenido: `
      <h1>Iglesias</h1>
      <p class="sub">
        ${todas.length} en total · ${activas} al día${atencion ? ' · <strong>' + atencion + ' requieren atención</strong>' : ''}
      </p>
      <div class="tarjeta" style="padding:0">
        ${
          todas.length
            ? `<table>
                 <tr>
                   <th>Iglesia</th><th>Estado</th>
                   <th class="opcional">Vigente hasta</th><th class="opcional">Equipos</th>
                   <th class="opcional">Última conexión</th>
                 </tr>
                 ${filas}
               </table>`
            : `<p class="vacio">Todavía no hay ninguna iglesia dada de alta.</p>`
        }
      </div>
      <a class="boton" href="/admin/nueva">Dar de alta una iglesia</a>
      ${pruebasEnCurso()}`,
  });
}

/**
 * Quién está probando Lámpara ahora mismo.
 *
 * Son equipos, no clientes: alguien que instaló el programa y todavía no habló
 * con nadie. Es la lista de dónde puede salir la próxima venta, y también donde
 * se nota si un mismo lugar reinstala una y otra vez.
 */
function pruebasEnCurso() {
  const lista = db.equiposDe(licencias.CLIENTE_PRUEBA);
  if (!lista.length) return '';

  const filas = lista
    .map((e) => {
      const quedan = Math.ceil((new Date(e.primera_vez).getTime() + licencias.DIAS_PRUEBA * MS_DIA - Date.now()) / MS_DIA);
      const s = quedan > 7 ? 'ok' : quedan > 0 ? 'aviso' : 'malo';
      const texto = quedan > 0 ? 'Quedan ' + quedan + (quedan === 1 ? ' día' : ' días') : 'Prueba terminada';
      return `<tr>
        <td class="mono">${escapar(e.huella.slice(0, 12))}…</td>
        <td><span class="etiqueta ${s}">${escapar(texto)}</span></td>
        <td class="opcional">${escapar(fecha(e.primera_vez))}</td>
        <td class="opcional">${escapar(hace(e.ultima_vez))}</td>
      </tr>`;
    })
    .join('');

  return `
    <h2>En período de prueba</h2>
    <p class="sub">Equipos con Lámpara recién instalada que todavía no son clientes.</p>
    <div class="tarjeta" style="padding:0">
      <table>
        <tr>
          <th>Equipo</th><th>Prueba</th>
          <th class="opcional">Instalado</th><th class="opcional">Última vez</th>
        </tr>
        ${filas}
      </table>
    </div>`;
}

function campos(i = {}) {
  return `
    <label>Nombre de la iglesia
      <input name="nombre" value="${escapar(i.nombre)}" required maxlength="120">
    </label>
    <div class="fila">
      <label>Persona de contacto
        <input name="contactoNombre" value="${escapar(i.contacto_nombre)}" maxlength="120">
      </label>
      <label>Teléfono
        <input name="contactoTelefono" value="${escapar(i.contacto_telefono)}" maxlength="60">
      </label>
    </div>
    <div class="fila">
      <label>Correo
        <input type="email" name="contactoCorreo" value="${escapar(i.contacto_correo)}" maxlength="160">
      </label>
      <label>Dirección
        <input name="direccion" value="${escapar(i.direccion)}" maxlength="200">
      </label>
    </div>
    <label>Notas
      <textarea name="notas" maxlength="2000">${escapar(i.notas)}</textarea>
    </label>`;
}

/**
 * Los equipos que han pedido licencia con este cliente.
 *
 * Lámpara admite un equipo autorizado por licencia — el primero que se conecta
 * se queda con el cupo, solo. Si aparece otro, se anota aquí en vez de que la
 * iglesia se quede adivinando por qué de repente no proyecta: basta con
 * autorizar el correcto para que vuelva a andar.
 */
function equipos(ses, i, aviso) {
  const lista = db.equiposDe(i.id);
  const usadas = db.equiposAutorizados(i.id);
  const permitidas = i.equipos_permitidos;

  const control = `
    <form method="post" action="/admin/iglesias/${escapar(i.id)}/licencias" class="acciones" style="margin-bottom:16px">
      <input type="hidden" name="csrf" value="${escapar(ses.csrf)}">
      <label style="margin:0">Computadoras permitidas
        <input type="number" name="equipos" value="${escapar(permitidas)}" min="1" max="99" style="width:90px">
      </label>
      <button class="primario" type="submit" style="align-self:end">Guardar</button>
      <span class="pista" style="align-self:end">
        ${usadas} de ${permitidas} en uso${usadas > permitidas ? ' — hay más equipos activos que licencias' : ''}
      </span>
    </form>
    ${aviso === 'lleno' ? `<div class="aviso-caja malo">Ya están ocupadas las ${permitidas} licencias. Sube el número o da de baja otro equipo antes de autorizar este.</div>` : ''}`;

  if (!lista.length) {
    return control + '<p class="pista">Ningún equipo se ha conectado todavía. Aparecerán aquí en cuanto abran Lámpara con internet.</p>';
  }

  const filas = lista
    .map((e) => {
      const accion = e.autorizado ? 'revocar-equipo' : 'autorizar-equipo';
      const marca = e.autorizado
        ? { clase: 'ok', texto: 'Con licencia' }
        : e.bloqueado
          ? { clase: 'malo', texto: 'Dado de baja' }
          : { clase: 'aviso', texto: 'Sin licencia' };
      return `<tr>
        <td class="mono">${escapar(e.huella.slice(0, 12))}…</td>
        <td><span class="etiqueta ${marca.clase}">${escapar(marca.texto)}</span></td>
        <td class="opcional">${escapar(fecha(e.primera_vez))}</td>
        <td>${escapar(hace(e.ultima_vez))}</td>
        <td>
          <form method="post" action="/admin/iglesias/${escapar(i.id)}/${accion}" style="margin:0">
            <input type="hidden" name="csrf" value="${escapar(ses.csrf)}">
            <input type="hidden" name="huella" value="${escapar(e.huella)}">
            <button type="submit"${e.autorizado ? ' class="peligro"' : ''}>${e.autorizado ? 'Dar de baja' : 'Autorizar'}</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');

  return `${control}
    <table>
      <tr>
        <th>Equipo</th><th>Estado</th>
        <th class="opcional">Desde</th><th>Última vez</th><th></th>
      </tr>
      ${filas}
    </table>`;
}

function vistaNueva(ses, error) {
  return pagina({
    titulo: 'Nueva iglesia',
    sesion: ses,
    contenido: `
      <h1>Dar de alta una iglesia</h1>
      <p class="sub">Se crea con un mes de vigencia; después se renueva desde su ficha.</p>
      ${error ? `<div class="aviso-caja malo">${escapar(error)}</div>` : ''}
      <form method="post" action="/admin/nueva" class="tarjeta">
        <input type="hidden" name="csrf" value="${escapar(ses.csrf)}">
        ${campos()}
        <div class="acciones">
          <button class="primario" type="submit">Crear</button>
          <a class="boton" href="/admin">Cancelar</a>
        </div>
      </form>`,
  });
}

function vistaDetalle(ses, i, urlPublica, mensaje, aviso) {
  const s = semaforo(i);
  const csrf = `<input type="hidden" name="csrf" value="${escapar(ses.csrf)}">`;

  const eventos = db
    .historial(i.id)
    .map((e) => `<li><strong>${escapar(e.tipo)}</strong> · ${escapar(fechaHora(e.cuando))}${e.detalle ? ' — ' + escapar(e.detalle) : ''}</li>`)
    .join('');

  const cambiosEstado = licencias.ESTADOS.filter((e) => e !== i.estado)
    .map((e) => `<button name="estado" value="${e}"${e === 'activo' ? ' class="primario"' : ''}>${
      { activo: 'Reactivar', moroso: 'Marcar morosa', suspendido: 'Suspender' }[e]
    }</button>`)
    .join('');

  return pagina({
    titulo: i.nombre,
    sesion: ses,
    contenido: `
      <h1>${escapar(i.nombre)} <span class="etiqueta ${s.clase}">${escapar(s.texto)}</span></h1>
      <p class="sub mono">${escapar(i.id)}</p>
      ${mensaje ? `<div class="aviso-caja">${escapar(mensaje)}</div>` : ''}

      <div class="tarjeta">
        <h2 style="margin-top:0">Licencia</h2>
        <p>
          Vigente hasta <strong>${escapar(fecha(i.vigente_hasta))}</strong> ·
          plan ${escapar(i.plan)} ·
          última conexión de la app: <strong>${escapar(hace(i.ultima_revision_en))}</strong>
          ${i.revisiones ? ` (${i.revisiones} en total)` : ''}
        </p>
        <form method="post" action="/admin/iglesias/${escapar(i.id)}/renovar" class="acciones" style="margin-bottom:16px">
          ${csrf}
          <span class="pista">Renovar:</span>
          <button name="meses" value="1">1 mes</button>
          <button name="meses" value="3">3 meses</button>
          <button name="meses" value="6">6 meses</button>
          <button name="meses" value="12" class="primario">1 año</button>
        </form>
        <form method="post" action="/admin/iglesias/${escapar(i.id)}/estado" class="acciones">
          ${csrf}
          <span class="pista">Estado de cuenta:</span>
          ${cambiosEstado}
        </form>
      </div>

      <div class="tarjeta">
        <h2 style="margin-top:0">Equipos</h2>
        ${equipos(ses, i, aviso)}
      </div>

      <div class="tarjeta">
        <h2 style="margin-top:0">Entregar la licencia</h2>
        <p class="pista">
          La app la recoge sola al arrancar, desde esta dirección. Solo hace falta
          descargarla a mano si el equipo de la iglesia no tiene internet: se le
          envía el archivo y se instala con <em>Ayuda › Instalar archivo de licencia</em>.
        </p>
        <p><code>${escapar(urlPublica)}/licencias/${escapar(i.id)}</code></p>
        <div class="acciones">
          <a class="boton" href="/admin/iglesias/${escapar(i.id)}/licencia.json">Descargar licencia.json</a>
        </div>
      </div>

      <div class="tarjeta">
        <h2 style="margin-top:0">Datos</h2>
        <form method="post" action="/admin/iglesias/${escapar(i.id)}">
          ${csrf}
          ${campos(i)}
          <div class="acciones"><button class="primario" type="submit">Guardar</button></div>
        </form>
      </div>

      <h2>Historial</h2>
      <ul class="bitacora">${eventos || '<li>Sin movimientos.</li>'}</ul>

      <form method="post" action="/admin/iglesias/${escapar(i.id)}/eliminar"
            onsubmit="return confirm('¿Eliminar a ${escapar(i.nombre)}? Su licencia dejará de renovarse.')">
        ${csrf}
        <button class="peligro" type="submit">Eliminar iglesia</button>
      </form>
      <p style="margin-top:24px"><a href="/admin">← Volver</a></p>`,
  });
}

module.exports = { semaforo, fecha, fechaHora, hace, vistaEntrar, vistaLista, vistaNueva, vistaDetalle };
