/**
 * Detectores: el paso intermedio entre "empiezas en cero" y "hace falta un
 * parser".
 *
 * El mayor obstaculo del proyecto es que el indice arranca vacio, y la unica
 * respuesta que habia era disciplina. La disciplina no escala a tres mil
 * ficheros. Un detector no entiende el lenguaje: reconoce una CONVENCION que el
 * equipo declara en un fichero versionado.
 *
 *   maui-page:
 *     detect:
 *       files: ["**\/*Page.xaml.cs"]
 *       contains: ["\\bContentPage\\b"]
 *
 * Eso no rompe la promesa de no parsear. Una expresion regular no sabe que es
 * una clase; sabe que en este equipo las paginas se llaman asi. Y generaliza
 * sin esfuerzo a `*.controller.ts`, `@Scheduled`, `models.py` o `func Test`.
 *
 * Lo que produce son CANDIDATOS, nunca hechos verificados: `confidence:
 * unverified` y `source: rule:<id>`. Un fichero que casa con un glob es una
 * conjetura razonable sobre donde mirar, no una afirmacion sobre el codigo.
 */

import fs from 'node:fs';
import path from 'node:path';
import { globMatcher } from './glob.js';
import { trackedFiles } from './git.js';

/**
 * Ficheros que nunca son fuente, para el recorrido de respaldo sin git.
 * Con git no hace falta: `.gitignore` ya los excluye.
 */
const DIRS_IGNORADOS = new Set([
  '.git', '.edgelore', '.claude', 'node_modules', 'obj', 'bin', 'dist', 'build',
  'target', 'vendor', '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'packages',
]);

/**
 * Tope de tamano al buscar `contains`.
 *
 * Un fichero de medio mega no es codigo que alguien lea: es un recurso
 * generado, una migracion o un volcado. Leerlos multiplicaria el coste del
 * escaneo por nada.
 */
const MAX_BYTES = 512 * 1024;

function walk(root, dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') {
      if (DIRS_IGNORADOS.has(entry.name)) continue;
    }
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (DIRS_IGNORADOS.has(entry.name)) continue;
      walk(root, rel, acc);
    } else if (entry.isFile()) {
      acc.push(rel);
    }
  }
}

/** Todos los ficheros candidatos del repositorio, con / como separador. */
export function repoFiles(root) {
  const tracked = trackedFiles(root);
  if (tracked) return tracked;
  const acc = [];
  walk(root, '', acc);
  return acc;
}

/** true si el contenido del fichero casa con TODAS las expresiones dadas. */
function contentMatches(root, file, patterns) {
  if (!patterns.length) return true;
  try {
    const full = path.join(root, file);
    if (fs.statSync(full).size > MAX_BYTES) return false;
    const text = fs.readFileSync(full, 'utf8');
    // Un byte nulo en la cabecera delata un binario; leerlo como texto daria
    // basura sobre la que cualquier expresion regular acierta o falla al azar.
    if (text.slice(0, 4096).includes('\0')) return false;
    return patterns.every((regex) => regex.test(text));
  } catch {
    return false;
  }
}

/**
 * Deriva un id a partir de la ruta.
 *
 * Es la parte fragil y por eso es declarativa: `Erp.Ui.DetallePage` no se puede
 * adivinar desde `src/Ui/DetallePage.xaml.cs` sin saber que `src/` sobra y que
 * el proyecto vive bajo `Erp`. La regla lo declara una vez; por defecto se hace
 * lo unico defendible sin saber nada: quitar la extension y cambiar / por punto.
 *
 * El id derivado sale SIEMPRE en la salida para que se revise. Un id equivocado
 * no rompe nada, pero genera un nodo del que nadie se acuerda, y eso es basura
 * que alguien tendra que limpiar.
 */
export function deriveId(file, idRules = {}) {
  let rel = file;
  for (const prefix of idRules.strip_prefix ?? []) {
    if (rel.startsWith(prefix)) {
      rel = rel.slice(prefix.length);
      break;
    }
  }
  const sufijos = idRules.strip_suffix ?? [];
  // Del sufijo mas largo al mas corto: con [".cs", ".xaml.cs"] declarados en
  // cualquier orden, `.xaml.cs` tiene que ganar o quedaria `DetallePage.xaml`.
  for (const suffix of [...sufijos].sort((a, b) => b.length - a.length)) {
    if (rel.endsWith(suffix)) {
      rel = rel.slice(0, -suffix.length);
      break;
    }
  }
  if (!sufijos.length) rel = rel.replace(/\.[^./]+$/, '');

  const id = `${idRules.prefix ?? ''}${rel.split('/').filter(Boolean).join('.')}`;
  // Los ids empiezan por letra o guion bajo; una ruta que empiece por digito
  // produciria un id que `validateNode` rechaza despues, cuando ya no hay
  // contexto para explicar por que.
  return /^[A-Za-z_]/.test(id) ? id : `_${id}`;
}

/**
 * Candidatos por kind: ficheros que casan con el detector y no tienen hecho.
 *
 * Devuelve tambien `yaCubiertos` para poder decir "de los 340 que casan, 12 son
 * nuevos": sin ese denominador, un detector mal escrito que casa con medio
 * repositorio parece un hallazgo en vez de un error.
 */
export function scanCandidates(root, catalog, index, { kind = null } = {}) {
  const cubiertos = new Set();
  for (const node of index.nodes.values()) if (node.file) cubiertos.add(node.file);

  const files = repoFiles(root);
  const resultados = [];

  for (const [nombreKind, definition] of catalog) {
    if (kind && nombreKind !== kind) continue;
    const detect = definition.detect;
    if (!detect?.files) continue;

    const casaRuta = globMatcher(detect.files);
    const patrones = (detect.contains ?? []).map((source) => new RegExp(source));

    const nuevos = [];
    let yaCubiertos = 0;
    for (const file of files) {
      if (!casaRuta(file)) continue;
      if (!contentMatches(root, file, patrones)) continue;
      if (cubiertos.has(file)) {
        yaCubiertos += 1;
        continue;
      }
      nuevos.push({ file, id: deriveId(file, detect.id ?? {}) });
    }

    if (nuevos.length || yaCubiertos) {
      nuevos.sort((a, b) => a.file.localeCompare(b.file));
      resultados.push({ kind: nombreKind, ruleId: definition.ruleId, nuevos, yaCubiertos });
    }
  }

  return resultados.sort((a, b) => b.nuevos.length - a.nuevos.length || a.kind.localeCompare(b.kind));
}
