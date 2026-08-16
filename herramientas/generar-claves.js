#!/usr/bin/env node
//
// Genera el par de firma del portal. Se corre UNA vez, en el servidor.
//
//   npm run claves
//
// Después hay que copiar la clave pública a la app —lo dice la salida— y volver
// a empaquetar el instalador. Sin eso la app sigue validando contra la clave de
// desarrollo y rechazará todo lo que emita el portal.
'use strict';

const fs = require('fs');
const licencias = require('../servidor/licencias');

const forzar = process.argv.includes('--forzar');

let rutas;
try {
  rutas = licencias.generarClaves({ forzar });
} catch (e) {
  console.error('\n' + e.message);
  console.error('\nSi de verdad hay que rehacerlas, agrega --forzar y prepárate para');
  console.error('reinstalar la licencia en cada iglesia que ya tenga Lámpara.\n');
  process.exit(1);
}

console.log('\nPar de firma generado:');
console.log('  privada: ' + rutas.privada + '   ← NUNCA sale de este servidor');
console.log('  pública: ' + rutas.publica);

console.log('\n--- Copia esto a app/recursos/licencia-clave-publica.pem en el repo de la app ---\n');
process.stdout.write(fs.readFileSync(rutas.publica, 'utf8'));
console.log('\nY después:');
console.log('  1. cd app && npm run licencia:emitir -- --prueba   (para rehacer la prueba del instalador)');
console.log('  2. npm run empaquetar');
console.log('  3. npm run probar:licencia && npm run probar:empaquetado\n');
