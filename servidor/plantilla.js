// El HTML del panel. Todo a mano y sin motor de plantillas: son seis pantallas
// y meter una dependencia para esto costaría más de lo que ahorra.
//
// Regla que no se rompe: cualquier dato que venga de la base pasa por
// `escapar()`. Los nombres de iglesia y las notas los escribe una persona, y un
// apóstrofo mal puesto no puede convertirse en HTML.
'use strict';

function escapar(valor) {
  return String(valor == null ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ESTILOS = `
  :root {
    --fondo: #f6f7f9; --papel: #fff; --texto: #1c2024; --tenue: #667085;
    --borde: #e3e6ea; --acento: #b4530a; --acento-suave: #fdf3e7;
    --ok: #1a7f47; --aviso: #9a6700; --malo: #b42318;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fondo: #16181c; --papel: #1e2126; --texto: #e8eaed; --tenue: #9aa1ac;
      --borde: #2e333a; --acento: #f0a35e; --acento-suave: #2a2118;
      --ok: #4ac07d; --aviso: #e0b341; --malo: #f2776b;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--fondo); color: var(--texto);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    background: var(--papel); border-bottom: 1px solid var(--borde);
    padding: 14px 24px; display: flex; align-items: center; gap: 16px;
  }
  header .marca { font-weight: 600; font-size: 17px; }
  header .marca span { color: var(--acento); }
  header nav { margin-left: auto; display: flex; gap: 16px; align-items: center; }
  main { max-width: 980px; margin: 0 auto; padding: 28px 24px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 32px 0 12px; }
  .sub { color: var(--tenue); margin: 0 0 24px; }
  a { color: var(--acento); }
  .tarjeta {
    background: var(--papel); border: 1px solid var(--borde);
    border-radius: 10px; padding: 20px; margin-bottom: 20px;
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 11px 12px; border-bottom: 1px solid var(--borde); }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--tenue); }
  tr:last-child td { border-bottom: 0; }
  .vacio { color: var(--tenue); text-align: center; padding: 36px 12px; }
  .etiqueta {
    display: inline-block; padding: 2px 9px; border-radius: 20px;
    font-size: 12px; font-weight: 600; white-space: nowrap;
  }
  .etiqueta.ok { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .etiqueta.aviso { background: color-mix(in srgb, var(--aviso) 18%, transparent); color: var(--aviso); }
  .etiqueta.malo { background: color-mix(in srgb, var(--malo) 15%, transparent); color: var(--malo); }
  label { display: block; margin-bottom: 14px; font-size: 13px; color: var(--tenue); }
  input, select, textarea {
    display: block; width: 100%; margin-top: 5px; padding: 9px 11px;
    border: 1px solid var(--borde); border-radius: 7px;
    background: var(--fondo); color: var(--texto); font: inherit;
  }
  textarea { min-height: 76px; resize: vertical; }
  .fila { display: flex; gap: 16px; flex-wrap: wrap; }
  .fila > label { flex: 1 1 220px; }
  button, .boton {
    display: inline-block; padding: 9px 16px; border-radius: 7px; border: 1px solid var(--borde);
    background: var(--papel); color: var(--texto); font: inherit; font-weight: 500;
    cursor: pointer; text-decoration: none;
  }
  button.primario { background: var(--acento); border-color: var(--acento); color: #fff; }
  button.peligro { color: var(--malo); border-color: color-mix(in srgb, var(--malo) 40%, var(--borde)); }
  .acciones { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .aviso-caja {
    border-left: 3px solid var(--acento); background: var(--acento-suave);
    padding: 12px 16px; border-radius: 0 8px 8px 0; margin-bottom: 20px;
  }
  .aviso-caja.malo { border-left-color: var(--malo); background: color-mix(in srgb, var(--malo) 8%, transparent); }
  code, .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 13px; }
  .id { color: var(--tenue); }
  .pista { color: var(--tenue); font-size: 13px; }
  .bitacora li { margin-bottom: 7px; color: var(--tenue); font-size: 13px; }
  .entrar { max-width: 380px; margin: 12vh auto; }
  @media (max-width: 620px) {
    main { padding: 20px 14px 48px; }
    th.opcional, td.opcional { display: none; }
  }
`;

function pagina({ titulo, contenido, sesion, activo }) {
  const nav = sesion
    ? `<nav>
         <a href="/admin">Iglesias</a>
         <form method="post" action="/admin/salir" style="margin:0">
           <input type="hidden" name="csrf" value="${escapar(sesion.csrf)}">
           <button>Salir</button>
         </form>
       </nav>`
    : '';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapar(titulo)} · Portal de Lámpara</title>
<style>${ESTILOS}</style>
</head>
<body>
${sesion ? `<header><div class="marca">Portal de <span>Lámpara</span></div>${nav}</header>` : ''}
<main${activo ? ' data-seccion="' + escapar(activo) + '"' : ''}>
${contenido}
</main>
</body>
</html>`;
}

module.exports = { escapar, pagina };
