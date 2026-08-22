/**
 * Comandos de lectura: query, find, path, stats, kinds, checklist.
 *
 * Todos comparten la misma disciplina: salida compacta pensada para entrar en el
 * contexto de un agente. Si una respuesta empieza a parecer un volcado, el
 * comando esta mal disenado.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  loadIndex,
  requireStoreRoot,
  danglingIds,
  paths,
} from '../store.js';
import {
  neighbourhood,
  renderNeighbourhood,
  search,
  renderSearch,
  path as findPath,
  renderPath,
  stats,
  renderStats,
  impact,
  renderImpact,
  workList,
  renderWorkList,
} from '../query.js';
import { loadRules, kindCatalog, renderKinds, checklistFor, renderChecklist } from '../rules.js';
import { changedSince, isGitRepo, lastCommitFor } from '../git.js';

export function cmdQuery(args, options) {
  const id = args[0];
  if (!id) throw new Error('Uso: edgelore query <id>');
  const root = requireStoreRoot();
  const index = loadIndex(root);
  const result = neighbourhood(index, id);

  if (!result) {
    const hits = search(index, id, { limit: 5 });
    const lines = [`No hay ningun hecho registrado para "${id}".`];
    if (hits.length) {
      lines.push('', 'Quiza te refieres a:');
      hits.forEach((hit) => lines.push(`  ${hit.id}`));
    }
    lines.push('', `Registralo con: edgelore add ${id} --file <ruta> --kind <kind>`);
    return { output: lines.join('\n'), code: 1 };
  }

  if (options.json) return { output: JSON.stringify(result, null, 2) };
  return { output: renderNeighbourhood(result, { notes: !options.brief, limit: options.all ? 0 : options.limit }) };
}

/**
 * `impact` responde a "que se rompe si cambio esto". Es el comando que se usa
 * ANTES de tocar codigo, y el unico que recorre las dependencias de forma
 * transitiva: un cambio no solo afecta a quien te llama, sino a quien llama a
 * quien te llama.
 */
export function cmdImpact(args, options) {
  const id = args[0];
  if (!id) throw new Error('Uso: edgelore impact <id> [--depth N] [--files] [--module <prefijo>]');
  const index = loadIndex(requireStoreRoot());
  const depth = Number.isFinite(options.depth) && options.depth > 0 ? options.depth : 4;
  const result = impact(index, id, { maxDepth: depth });

  if (options.json) return { output: JSON.stringify(result, null, 2) };
  if (!result.known && result.affected === 0) {
    const hits = search(index, id, { limit: 5 });
    const lines = [`"${id}" no aparece en el indice, ni con ficha propia ni referenciado.`];
    if (hits.length) {
      lines.push('', 'Quiza te refieres a:');
      hits.forEach((hit) => lines.push(`  ${hit.id}`));
    }
    lines.push('', 'Sin datos no se puede acotar el alcance: usa grep y registra lo que descubras.');
    return { output: lines.join('\n'), code: 1 };
  }
  // --files cambia la pregunta: de "cuanto alcance tiene" a "que abro para
  // revisarlo". Por eso no se recorta; se acota con --module y --depth.
  if (options.files) {
    const lista = workList(result, { module: options.module });
    return { output: renderWorkList(result, lista, { module: options.module }) };
  }
  return { output: renderImpact(result, index, { limit: options.all ? 0 : options.limit }) };
}

export function cmdFind(args, options) {
  const term = args.join(' ');
  if (!term) throw new Error('Uso: edgelore find <texto>');
  const index = loadIndex(requireStoreRoot());
  const hits = search(index, term, { limit: options.limit ?? 20 });
  if (options.json) return { output: JSON.stringify(hits, null, 2) };
  return { output: renderSearch(hits, term), code: hits.length ? 0 : 1 };
}

export function cmdPath(args, options) {
  const [from, to] = args;
  if (!from || !to) throw new Error('Uso: edgelore path <desde> <hasta>');
  const index = loadIndex(requireStoreRoot());
  const steps = findPath(index, from, to);
  if (options.json) return { output: JSON.stringify(steps, null, 2), code: steps ? 0 : 1 };
  return { output: renderPath(steps, from, to), code: steps ? 0 : 1 };
}

export function cmdStats(args, options) {
  const index = loadIndex(requireStoreRoot());
  const summary = stats(index);
  if (options.json) return { output: JSON.stringify({ ...summary, dangling: danglingIds(index) }, null, 2) };
  return { output: renderStats(summary, { dangling: danglingIds(index) }) };
}

export function cmdKinds(args, options) {
  const catalog = kindCatalog(loadRules(requireStoreRoot()));
  if (options.json) return { output: JSON.stringify([...catalog.values()], null, 2) };
  return { output: renderKinds(catalog) };
}

export function cmdChecklist(args, options) {
  const kind = args[0];
  if (!kind) throw new Error('Uso: edgelore checklist <kind>   (lista los kinds con `edgelore kinds`)');
  const catalog = kindCatalog(loadRules(requireStoreRoot()));
  const checklist = checklistFor(catalog, kind);
  if (!checklist) {
    return { output: `Kind "${kind}" desconocido. Ejecuta \`edgelore kinds\` para ver los disponibles.`, code: 1 };
  }
  if (options.json) return { output: JSON.stringify(checklist, null, 2) };
  return { output: renderChecklist(checklist) };
}

/**
 * Valida la coherencia interna del indice. Pensado para correr en CI: es la
 * unica defensa automatica contra que el indice acumule mentiras.
 */
export function cmdValidate(args, options) {
  const root = requireStoreRoot();
  const index = loadIndex(root);
  const problems = [...index.problems];

  for (const node of index.nodes.values()) {
    if (node.file && !fs.existsSync(path.join(root, node.file))) {
      problems.push(`${node.id}: el fichero declarado no existe (${node.file})`);
    }
  }

  const dangling = danglingIds(index);
  const lines = [];
  if (problems.length) {
    lines.push(`${problems.length} problema(s):`);
    problems.forEach((problem) => lines.push(`  ${problem}`));
  }
  if (dangling.length && options.strict) {
    lines.push('', `${dangling.length} id(s) referenciados sin ficha propia (--strict):`);
    dangling.forEach((id) => lines.push(`  ${id}`));
  }

  const failed = problems.length > 0 || (options.strict && dangling.length > 0);
  if (!failed) {
    lines.push(`Indice coherente: ${index.nodes.size} nodo(s), sin problemas.`);
    if (dangling.length) lines.push(`(${dangling.length} id(s) referenciados aun sin ficha propia; usa --strict para exigirlos)`);
  }
  return { output: lines.join('\n'), code: failed ? 1 : 0 };
}

/**
 * Lista los hechos cuyo fichero de codigo cambio despues de verificarlos. No
 * afirma que el hecho sea falso: afirma que nadie lo ha vuelto a mirar.
 */
export function cmdStale(args, options) {
  const root = requireStoreRoot();
  if (!isGitRepo(root)) {
    return { output: 'Este directorio no es un repositorio git; no se puede calcular la caducidad.', code: 1 };
  }
  const index = loadIndex(root);
  const stale = [];
  const unverified = [];

  for (const node of index.nodes.values()) {
    if (!node.file) continue;
    if (!node.verified?.commit) {
      unverified.push(node);
      continue;
    }
    if (changedSince(root, node.verified.commit, node.file)) {
      stale.push({ id: node.id, file: node.file, since: node.verified.commit, last: lastCommitFor(root, node.file) });
    }
  }

  if (options.json) return { output: JSON.stringify({ stale, unverified: unverified.map((n) => n.id) }, null, 2) };

  const lines = [];
  if (stale.length) {
    lines.push(`${stale.length} hecho(s) por revisar (el codigo cambio despues de verificarlos):`);
    stale.forEach((entry) => lines.push(`  ${entry.id}\n    ${entry.file}  ${entry.since} -> ${entry.last}`));
    lines.push('', 'Revisalo y confirma con: edgelore verify <id>');
  }
  if (unverified.length) {
    lines.push('', `${unverified.length} hecho(s) sin verificar nunca:`);
    unverified.slice(0, 20).forEach((node) => lines.push(`  ${node.id}`));
    if (unverified.length > 20) lines.push(`  ... y ${unverified.length - 20} mas`);
  }
  if (!lines.length) lines.push('Todos los hechos verificados siguen al dia.');
  return { output: lines.join('\n'), code: stale.length ? 1 : 0 };
}
