#!/usr/bin/env node
//
// Emite la licencia de prueba que viaja DENTRO del instalador de Lámpara.
//
//   node herramientas/emitir-prueba.js
//
// Tiene que correr en el servidor, porque la clave privada vive solo ahí. Lo
// que imprime se guarda como `app/recursos/licencia-prueba.json` en el repo de
// la app y se vuelve a empaquetar.
//
// Por qué existe: todas las instalaciones nuevas arrancan con esta licencia, y
// si estuviera firmada con otra clave que la que valida la app, ninguna
// instalación nueva podría proyectar. Es el archivo que más veces se va a
// instalar de todos, así que se emite aparte y a propósito.
//
// Lleva `diasPrueba` —que las licencias del portal no llevan— porque este
// archivo se emite una sola vez y la iglesia lo instala meses después: con una
// fecha fija llegaría vencido. Cuenta 30 días desde el primer arranque en el
// equipo, y en cuanto ese equipo tenga internet el portal corrige la cuenta
// con la fecha real (ver README, "La prueba de 30 días la cuenta el servidor").
'use strict';

const licencias = require('../servidor/licencias');

const DIAS_OFERTA = 365;

const { texto, datos } = licencias.emitir({
  clienteId: licencias.CLIENTE_PRUEBA,
  nombreCliente: 'Período de prueba',
  estado: 'activo',
  plan: 'prueba',
  // Tope de la oferta: pasado un año, este instalador ya no estrena pruebas.
  vigenteHasta: new Date(Date.now() + DIAS_OFERTA * licencias.MS_DIA).toISOString(),
  diasPrueba: licencias.DIAS_PRUEBA,
  topeDeGracia: false,
});

console.error('Prueba emitida: ' + datos.diasPrueba + ' días desde el primer arranque, oferta hasta ' + datos.validoHasta.slice(0, 10));
console.error('Guarda lo que sigue como app/recursos/licencia-prueba.json y vuelve a empaquetar.\n');

process.stdout.write(texto);
