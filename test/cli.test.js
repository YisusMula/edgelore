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
import { execFileSync, execSync } from 'node:child_process';
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

test('una salida grande no se corta al pasar por una tuberia', () => {
  // Regresion: process.exit() mataba el proceso antes de vaciar stdout, y por
  // tuberia -que es como lo consumen el hook y cualquier agente- la salida se
  // cortaba a los 65.536 bytes, a mitad de linea y sin aviso.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'edgelore-grande-'));
  fs.mkdirSync(path.join(repo, 'src'));
  run(BIN, ['init', '--rules', 'dotnet-core'], { cwd: repo });

  const nodos = path.join(repo, '.edgelore', 'nodes');
  const TOTAL = 1200;   // suficiente para superar holgadamente los 65.536 bytes
  for (let i = 0; i < TOTAL; i += 1) {
    fs.writeFileSync(
      path.join(nodos, `Erp.Mod.Nodo${i}.md`),
      `---\nid: Erp.Mod.Nodo${i}\nfile: src/ficheroDeNombreLargoParaAbultar${i}.cs\nedges:\n`
        + '  - to: Objetivo\n    type: calls\n    confidence: certain\n    source: human\n---\n',
    );
  }
  fs.writeFileSync(path.join(nodos, 'Objetivo.md'), '---\nid: Objetivo\nedges: []\n---\n');

  // Hace falta una tuberia REAL con un consumidor que no drena al vuelo: con
  // execFileSync el padre lee segun el hijo escribe y el bufer nunca se llena,
  // de modo que el fallo no se reproduce. Una tuberia de shell si lo hace.
  const salida = execSync(`"${process.execPath}" "${BIN}" impact Objetivo --files | cat`, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.ok(salida.length > 65536, `el corpus debe superar los 64 KB para probar el corte (${salida.length})`);

  // Completitud medida, no estimada: deben aparecer los 1.200 ficheros.
  const vistos = (salida.match(/ficheroDeNombreLargoParaAbultar\d+\.cs/g) ?? []).length;
  assert.equal(vistos, TOTAL, `solo llegaron ${vistos} de ${TOTAL} ficheros: la tuberia corta la salida`);
  assert.match(salida, new RegExp(`${TOTAL} fichero\\(s\\)`));
});

test('stale detecta los mismos hechos agrupando las llamadas a git', () => {
  // Regresion de rendimiento: se preguntaba a git una vez por hecho, y con
  // 3.000 hechos verificados eran 13 segundos en un comando pensado para CI.
  // Agrupar por commit no puede cambiar QUE se detecta, solo cuanto tarda.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'edgelore-stale-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, 'src'));
  git('init', '-q');
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');

  // Incluye una ruta con espacio y tilde: git las entrecomilla al listarlas por
  // lineas, y por eso filesChangedSince usa -z.
  const ficheros = ['A.cs', 'B.cs', 'con acento ñ.cs'];
  for (const f of ficheros) fs.writeFileSync(path.join(repo, 'src', f), 'class X {}\n');
  git('add', '-A');
  git('commit', '-qm', 'base');

  run(BIN, ['init', '--rules', 'dotnet-core'], { cwd: repo });
  ficheros.forEach((f, i) => run(BIN, ['add', `Nodo${i}`, '--file', `src/${f}`], { cwd: repo }));
  git('add', '-A');
  git('commit', '-qm', 'hechos');

  assert.match(run(BIN, ['stale'], { cwd: repo }), /siguen al dia/);

  fs.appendFileSync(path.join(repo, 'src', 'A.cs'), '// cambio\n');
  fs.appendFileSync(path.join(repo, 'src', 'con acento ñ.cs'), '// cambio\n');
  git('add', '-A');
  git('commit', '-qm', 'cambios');

  const salida = run(BIN, ['stale'], { cwd: repo, expectFailure: true });
  assert.match(salida, /Nodo0/, 'A.cs cambio y debe marcarse');
  assert.match(salida, /Nodo2/, 'la ruta con espacio y tilde tambien debe detectarse');
  assert.ok(!/Nodo1\b/.test(salida.split('sin verificar')[0]), 'B.cs no cambio y no debe marcarse');
});
