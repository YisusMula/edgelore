/**
 * Sondas de capacidad del entorno, para saltar pruebas que el sistema de
 * ficheros no puede ejecutar.
 *
 * Se comprueba la CAPACIDAD, no `process.platform`. Dos motivos concretos:
 *
 *   - Windows SI puede crear enlaces simbolicos con el modo desarrollador
 *     activado o como administrador. Saltar por plataforma dejaria sin cubrir
 *     justo la regresion mas cara que ha tenido este proyecto -el CLI instalado
 *     no ejecutaba nada- en las maquinas donde si se puede comprobar.
 *   - macOS distingue mayusculas tan poco como Windows por defecto. Saltar por
 *     plataforma dejaria la prueba fallando en Mac igual que fallaba en Windows.
 *
 * El objetivo es que `npm test` termine en verde en cualquier maquina del
 * equipo. Una suite que normaliza "cinco en rojo" deja de mirarse, y con ella
 * se pierde la unica senal automatica que hay.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sondear(fn) {
  let resultado;
  return () => {
    if (resultado === undefined) resultado = fn();
    return resultado;
  };
}

/** true si este sistema de ficheros permite crear enlaces simbolicos. */
export const puedeCrearSymlinks = sondear(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edgelore-sonda-'));
  try {
    fs.symlinkSync(path.join(dir, 'destino'), path.join(dir, 'enlace'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** true si dos ficheros que solo difieren en mayusculas pueden coexistir. */
export const distingueMayusculas = sondear(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edgelore-sonda-'));
  try {
    fs.writeFileSync(path.join(dir, 'a'), '');
    return !fs.existsSync(path.join(dir, 'A'));
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Opciones de node:test: salta con un motivo legible en vez de fallar. */
export const requiereSymlinks = () =>
  (puedeCrearSymlinks() ? {} : { skip: 'este sistema de ficheros no permite crear enlaces simbolicos' });

export const requiereMayusculas = () =>
  (distingueMayusculas()
    ? {}
    : { skip: 'este sistema de ficheros no distingue mayusculas, asi que los dos ficheros no pueden coexistir' });
