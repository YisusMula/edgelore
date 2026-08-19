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

/** Ficheros modificados respecto a HEAD, incluidos los no rastreados. */
export function dirtyFiles(root) {
  const out = git(root, ['status', '--porcelain']);
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}
