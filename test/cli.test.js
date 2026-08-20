/**
 * Pruebas que ejecutan el binario como proceso, no importando el modulo.
 *
 * Existen por un fallo real: npm instala el binario como un symlink, y la
 * guarda que impide que `main()` corra durante los tests comparaba rutas sin
 * resolver el enlace. El CLI instalado no ejecutaba nada y salia con codigo 0
 * en cada orden. Ningun test que importe el modulo puede detectar eso.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'edgelore.js');

function run(bin, args, { cwd, expectFailure = false } = {}) {
  try {
    return execFileSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (expectFailure) return `${error.stdout ?? ''}${error.stderr ?? ''}`;
    throw new Error(`fallo inesperado: ${error.stderr || error.message}`);
  }
}

/** Reproduce la disposicion que crea npm: node_modules/.bin/<nombre> -> fichero real. */
function symlinkedBin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edgelore-bin-'));
  const link = path.join(dir, 'edgelore');
  fs.symlinkSync(BIN, link);
  return link;
}

test('el binario responde a --version ejecutado directamente', () => {
  assert.match(run(BIN, ['--version']), /^\d+\.\d+\.\d+/);
});

test('el binario responde igual invocado a traves de un symlink', () => {
  // Regresion: aqui el CLI instalado no imprimia nada y salia con codigo 0.
  assert.match(run(symlinkedBin(), ['--version']), /^\d+\.\d+\.\d+/);
});

test('help lista los comandos a traves del symlink', () => {
  const salida = run(symlinkedBin(), ['help']);
  assert.match(salida, /impact/);
  assert.match(salida, /uninstall/);
});

test('un comando desconocido falla con codigo distinto de cero', () => {
  let code = 0;
  try {
    execFileSync(process.execPath, [symlinkedBin(), 'comando-inventado'], { stdio: 'pipe' });
  } catch (error) {
    code = error.status;
  }
  assert.equal(code, 2, 'un comando invalido debe fallar, no fingir exito');
});

test('el flujo completo funciona a traves del symlink', () => {
  const bin = symlinkedBin();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'edgelore-repo-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'P.cs'), 'class P {}\n');

  run(bin, ['init', '--rules', 'dotnet-maui'], { cwd: repo });
  assert.ok(fs.existsSync(path.join(repo, '.edgelore', 'rules', 'dotnet-maui.yaml')), 'las reglas deben copiarse');

  run(bin, ['add', 'Pagina', '--file', 'src/P.cs', '--kind', 'maui-page'], { cwd: repo });
  const salida = run(bin, ['query', 'Pagina'], { cwd: repo });
  assert.match(salida, /OnAppearing/, 'las reglas del kind deben haberse aplicado');
});

test('fuera de un repositorio con indice, el error es explicito', () => {
  const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'edgelore-vacio-'));
  const salida = run(BIN, ['query', 'X'], { cwd: vacio, expectFailure: true });
  assert.match(salida, /No se ha encontrado ningun indice/);
});
