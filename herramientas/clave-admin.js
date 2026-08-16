#!/usr/bin/env node
//
// Prepara la contraseña del panel.
//
//   npm run clave-admin                 inventa una buena y la muestra
//   npm run clave-admin -- "mi clave"   usa la tuya
//
// Lo que se guarda en el servidor es el hash, no la contraseña: quien lea el
// docker-compose no puede entrar con lo que ve ahí.
'use strict';

const crypto = require('crypto');
const sesion = require('../servidor/sesion');

const dada = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ');

// Sin ambigüedades al dictarla por teléfono: sin l/1/I ni O/0.
const ALFABETO = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function inventar(largo = 20) {
  const bytes = crypto.randomBytes(largo);
  return Array.from(bytes, (b) => ALFABETO[b % ALFABETO.length]).join('');
}

const clave = dada || inventar();

if (!dada) {
  console.log('\nContraseña generada (guárdala en tu gestor, no se vuelve a mostrar):\n');
  console.log('    ' + clave + '\n');
} else if (clave.length < 12) {
  console.error('\nEsa contraseña es demasiado corta. El panel emite licencias: usa al menos 12 caracteres.\n');
  process.exit(1);
}

console.log('Ponle esto al servidor como variable de entorno:\n');
console.log('    LAMPARA_ADMIN_CLAVE_HASH=' + sesion.crearHash(clave) + '\n');
