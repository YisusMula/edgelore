/**
 * Utilidades de git para detectar hechos caducados.
 *
 * El riesgo real de un indice curado no es quedarse corto: es MENTIR. Un hecho
 * que era cierto hace tres meses y ya no lo es hace mas dano que su ausencia,
 * porque se lee con confianza. Comparar el commit en que se verifico el hecho
 * con el ultimo commit que toco el fichero es la senal mas barata para
 * detectarlo, y no necesita ningun parser.
 */

import { execFileSync } from 'node:child_process';

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function isGitRepo(root) {
  return git(root, ['rev-parse', '--git-dir']) !== null;
}

export function headCommit(root) {
  return git(root, ['rev-parse', '--short', 'HEAD']);
}

export function currentUser(root) {
  return git(root, ['config', 'user.email']) || null;
}

/** Ultimo commit que modifico un fichero, o null si no esta versionado. */
export function lastCommitFor(root, file) {
  const out = git(root, ['log', '-1', '--format=%h', '--', file]);
  return out || null;
}

/** true si `file` cambio despues de `commit`. Ante la duda, no marca nada. */
export function changedSince(root, commit, file) {
  if (!commit) return false;
  const out = git(root, ['log', '--format=%h', `${commit}..HEAD`, '--', file]);
  if (out === null) return false;
  return out.length > 0;
}

/**
 * Todos los ficheros tocados desde `commit`, en UNA sola invocacion de git.
 *
 * Preguntar fichero a fichero cuesta un proceso por hecho: con 3.000 hechos
 * verificados eran 13 segundos, y `stale` esta pensado para correr en CI en cada
 * pull request. Como los hechos suelen compartir el commit en que se
 * verificaron, agrupar por commit reduce miles de invocaciones a unas pocas.
 *
 * Se usa -z porque git entrecomilla y escapa las rutas no ASCII cuando escribe
 * en lineas, y este proyecto tiene que funcionar con rutas en castellano.
 */
export function filesChangedSince(root, commit) {
  if (!commit) return null;
  const out = git(root, ['log', '-z', '--name-only', '--format=', `${commit}..HEAD`]);
  if (out === null) return null;
  return new Set(out.split('\0').map((line) => line.trim()).filter(Boolean));
}

/**
 * Rotacion por fichero en una ventana de tiempo: cuantos commits lo tocaron y
 * cuantas personas distintas.
 *
 * Una sola invocacion de git para todo el repositorio. Preguntar fichero a
 * fichero costaria un proceso por fichero, y esto se ejecuta sobre el arbol
 * entero, no sobre una lista corta.
 *
 * Se excluyen las mezclas: un merge que toca doscientos ficheros no dice nada
 * sobre ninguno de ellos y ahogaria la senal.
 *
 * Se usa -z porque git entrecomilla y escapa las rutas no ASCII al escribirlas
 * en lineas, y este proyecto tiene que funcionar con rutas en castellano.
 */
export function churn(root, { sinceDays = 90 } = {}) {
  const out = git(root, [
    'log',
    `--since=${sinceDays} days ago`,
    '--no-merges',
    '-z',
    '--format=%x01%an',
    '--name-only',
  ]);
  if (out === null) return null;

  const files = new Map();
  let autor = null;
  for (const raw of out.split('\0')) {
    const token = raw.trim();
    if (!token) continue;
    if (token.startsWith('\x01')) {
      autor = token.slice(1);
      continue;
    }
    if (!files.has(token)) files.set(token, { commits: 0, authors: new Set() });
    const entry = files.get(token);
    entry.commits += 1;
    if (autor) entry.authors.add(autor);
  }
  return files;
}

/**
 * Ficheros versionados, o null si no hay git.
 *
 * Preferirlo a recorrer el disco no es una optimizacion: git ya sabe que hay
 * que ignorar. Sin esto habria que reimplementar `.gitignore` -y equivocarse-
 * para no proponer `node_modules`, `obj/` y `bin/` como sitios donde registrar
 * hechos.
 */
export function trackedFiles(root) {
  const out = git(root, ['ls-files', '-z']);
  if (out === null) return null;
  return out.split('\0').map((line) => line.trim()).filter(Boolean);
}
