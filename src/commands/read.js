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
  classifyDangling,
  nodePath,
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
  didYouMean,
  ageInDays,
  formatAge,
  DEFAULT_MAX_AGE_DAYS,
} from '../query.js';
import { loadRules, kindCatalog, renderKinds, checklistFor, renderChecklist } from '../rules.js';
import { changedSince, filesChangedSince, isGitRepo, lastCommitFor } from '../git.js';
import { fingerprintFile } from '../fingerprint.js';

/**
 * Umbral de reverificacion en dias. Sin --max-age vale el de por defecto, que
 * es lo que hace que el desgaste se vea sin tener que pedirlo.
 */
function maxAgeFrom(options) {
  const value = Number(options['max-age']);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_AGE_DAYS;
}

export function cmdQuery(args, options) {
  const id = args[0];
  if (!id) throw new Error('Uso: edgelore query <id>');
  const root = requireStoreRoot();
  const index = loadIndex(root);
  const result = neighbourhood(index, id);

  if (!result) {
    const hits = didYouMean(index, id, { limit: 5 });
    const lines = [`No hay ningun hecho registrado para "${id}".`];
    if (hits.length) {
      lines.push('', 'Quiza te refieres a:');
      hits.forEach((sugerencia) => lines.push(`  ${sugerencia}`));
    }
    lines.push('', `Registralo con: edgelore add ${id} --file <ruta> --kind <kind>`);
    return { output: lines.join('\n'), code: 1 };
  }

  if (options.json) return { output: JSON.stringify(result, null, 2) };
  return {
    output: renderNeighbourhood(result, {
      notes: !options.brief,
      limit: options.all ? 0 : options.limit,
      maxAgeDays: maxAgeFrom(options),
    }),
  };
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
  const root = requireStoreRoot();
  const index = loadIndex(root);
  const depth = Number.isFinite(options.depth) && options.depth > 0 ? options.depth : 4;
  const result = impact(index, id, { maxDepth: depth });

  if (options.json) return { output: JSON.stringify(result, null, 2) };
  if (!result.known && result.affected === 0) {
    const hits = didYouMean(index, id, { limit: 5 });
    const lines = [`"${id}" no aparece en el indice, ni con ficha propia ni referenciado.`];
    if (hits.length) {
      lines.push('', 'Quiza te refieres a:');
      hits.forEach((sugerencia) => lines.push(`  ${sugerencia}`));
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
  return {
    output: renderImpact(result, index, {
      limit: options.all ? 0 : options.limit,
      maxAgeDays: maxAgeFrom(options),
    }),
  };
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

  // "No hay camino" y "ese nodo no existe" son problemas distintos, y
  // confundirlos manda a buscar una conexion que nunca fue el problema.
  const conocido = (id) => index.nodes.has(id) || index.incoming.has(id);
  const ausentes = [from, to].filter((id) => !conocido(id));
  if (ausentes.length) {
    const lines = ausentes.map((id) => `"${id}" no aparece en el indice.`);
    for (const id of ausentes) {
      const hits = didYouMean(index, id, { limit: 3 });
      if (hits.length) lines.push(`  quiza: ${hits.join(', ')}`);
    }
    return { output: lines.join('\n'), code: 1 };
  }

  const steps = findPath(index, from, to);
  if (options.json) return { output: JSON.stringify(steps, null, 2), code: steps ? 0 : 1 };
  return { output: renderPath(steps, from, to), code: steps ? 0 : 1 };
}

export function cmdStats(args, options) {
  const index = loadIndex(requireStoreRoot());
  const summary = stats(index);
  const { esperados, sospechosos } = classifyDangling(index);
  if (options.json) {
    return { output: JSON.stringify({ ...summary, dangling: danglingIds(index), esperados, sospechosos }, null, 2) };
  }
  return { output: renderStats(summary, { esperados, sospechosos }) };
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

  // Dos categorias que NO deben mezclarse.
  //
  // Un ERROR es un hecho mal escrito: esquema invalido, tipo de arista
  // inventado, id duplicado. Es culpa de quien lo escribio, se arregla al
  // momento y debe romper el build.
  //
  // Una DESINCRONIZACION es que el codigo se movio por debajo: alguien borro o
  // renombro un fichero. Es inevitable en cualquier repositorio vivo, y romper
  // el build por ella deja el CI en rojo permanente. Un CI que lleva meses en
  // rojo se ignora, y con el se pierde la unica defensa contra que el indice
  // mienta. Se informa, y solo rompe con --strict.
  const errores = [...index.problems];
  const desincronizados = [];

  for (const node of index.nodes.values()) {
    if (node.file && !fs.existsSync(path.join(root, node.file))) {
      desincronizados.push({ id: node.id, file: node.file });
    }
  }

  // Tercera categoria, y solo bajo peticion explicita: hechos que nadie
  // reverifica desde hace demasiado. No entra en la salida por defecto a
  // proposito. El desgaste por antiguedad es continuo y universal -todo hecho
  // envejece-, asi que informar de el sin que nadie lo haya pedido converge en
  // una lista que crece cada dia y que se acaba ignorando, arrastrando consigo
  // la atencion sobre las dos categorias que si son accionables.
  const caducados = [];
  if (options['max-age'] !== undefined) {
    const maxAgeDays = maxAgeFrom(options);
    for (const node of index.nodes.values()) {
      if (!node.verified?.date) continue;
      const days = ageInDays(node.verified.date);
      if (days !== null && days >= maxAgeDays) caducados.push({ id: node.id, days });
    }
    caducados.sort((a, b) => b.days - a.days || a.id.localeCompare(b.id));
  }

  const { esperados, sospechosos } = classifyDangling(index);
  const lines = [];

  if (errores.length) {
    lines.push(`${errores.length} error(es) de esquema:`);
    errores.forEach((problem) => lines.push(`  ${problem}`));
  }

  if (desincronizados.length) {
    if (lines.length) lines.push('');
    lines.push(`${desincronizados.length} hecho(s) apuntan a ficheros que ya no existen:`);
    desincronizados.slice(0, 15).forEach((entry) => lines.push(`  ${entry.id}  ->  ${entry.file}`));
    if (desincronizados.length > 15) lines.push(`  ... y ${desincronizados.length - 15} mas`);
    lines.push('  Si el fichero se movio: edgelore add <id> --file <ruta nueva>');
    lines.push('  Si ya no existe:        edgelore prune --apply');
  }

  if (sospechosos.length) {
    if (lines.length) lines.push('');
    lines.push(`${sospechosos.length} id(s) referenciados que nadie declara y no genera ninguna regla:`);
    sospechosos.slice(0, 15).forEach((id) => lines.push(`  ${id}`));
    if (sospechosos.length > 15) lines.push(`  ... y ${sospechosos.length - 15} mas`);
    lines.push('  Suelen ser restos de un renombrado hecho sin `edgelore rename`.');
  }

  if (caducados.length) {
    if (lines.length) lines.push('');
    lines.push(`${caducados.length} hecho(s) sin reverificar desde hace mas de ${maxAgeFrom(options)} dias:`);
    caducados.slice(0, 15).forEach((entry) => lines.push(`  ${entry.id}  (${formatAge(entry.days)})`));
    if (caducados.length > 15) lines.push(`  ... y ${caducados.length - 15} mas`);
    lines.push('  Confirmalos con: edgelore verify <id>');
  }

  if (!lines.length) {
    lines.push(`Indice coherente: ${index.nodes.size} nodo(s), sin problemas.`);
  }
  if (esperados.length) {
    lines.push('', `(${esperados.length} miembro(s) generados por reglas sin ficha propia: es lo normal)`);
  }

  // Solo el esquema rompe el build por defecto.
  const failed = errores.length > 0
    || (options.strict && (desincronizados.length > 0 || sospechosos.length > 0 || caducados.length > 0));
  return { output: lines.join('\n'), code: failed ? 1 : 0 };
}

/**
 * Elimina los hechos cuyo fichero ya no existe.
 *
 * `validate` avisa de la desincronizacion pero no puede resolverla: si el
 * fichero se movio hay que reapuntarlo, y si desaparecio hay que borrar el
 * hecho. Por eso se lista por defecto y solo se borra con --apply: un hecho
 * lleva dentro el porque, que es lo caro de recuperar.
 */
export function cmdPrune(args, options) {
  const root = requireStoreRoot();
  const index = loadIndex(root);
  const huerfanos = [...index.nodes.values()]
    .filter((node) => node.file && !fs.existsSync(path.join(root, node.file)))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (!huerfanos.length) {
    return { output: 'Ningun hecho apunta a un fichero inexistente.' };
  }

  const lines = [];
  if (!options.apply) {
    lines.push(`${huerfanos.length} hecho(s) apuntan a ficheros que ya no existen:`);
    huerfanos.forEach((node) => {
      const entrantes = (index.incoming.get(node.id) ?? []).length;
      lines.push(`  ${node.id}  ->  ${node.file}${entrantes ? `   (${entrantes} arista(s) apuntan a el)` : ''}`);
    });
    lines.push(
      '',
      'Nada se ha borrado. Antes de borrar, comprueba si el fichero se movio:',
      '  edgelore add <id> --file <ruta nueva>     conserva el hecho y sus notas',
      '',
      'Para eliminarlos de verdad: edgelore prune --apply',
    );
    return { output: lines.join('\n'), code: 1 };
  }

  for (const node of huerfanos) fs.rmSync(nodePath(root, node.id), { force: true });
  lines.push(`Eliminados ${huerfanos.length} hecho(s):`);
  huerfanos.forEach((node) => lines.push(`  ${node.id}`));
  const rotas = huerfanos.filter((node) => (index.incoming.get(node.id) ?? []).length);
  if (rotas.length) {
    lines.push('', `Aviso: ${rotas.length} de ellos tenian aristas entrantes, que quedan colgando.`);
    lines.push('Revisa con: edgelore validate');
  }
  return { output: lines.join('\n') };
}

/**
 * Lista los hechos cuyo fichero de codigo cambio despues de verificarlos. No
 * afirma que el hecho sea falso: afirma que nadie lo ha vuelto a mirar.
 */
export function cmdStale(args, options) {
  const root = requireStoreRoot();
  const index = loadIndex(root);
  const git = isGitRepo(root);
  const stale = [];
  const unverified = [];

  // La huella del contenido es el mecanismo; git solo enriquece.
  //
  // Antes era al reves y eso abria dos agujeros. Fuera de un repositorio git el
  // comando se negaba a funcionar entero. Y dentro, `filesChangedSince`
  // devuelve null cuando git no reconoce el commit del sello -lo que pasa en
  // cuanto alguien hace squash al mergear-, y ese null se interpretaba como
  // "ante la duda no marcar nada": los hechos verificados dejaban de
  // comprobarse EN SILENCIO y `stale` respondia "todos al dia" porque no podia
  // preguntar, no porque lo estuvieran.
  const porCommit = new Map();
  for (const node of index.nodes.values()) {
    if (!node.file) continue;
    if (!node.verified?.date) {
      unverified.push(node);
      continue;
    }
    if (node.verified.fingerprint) {
      const actual = fingerprintFile(root, node.file);
      // null = el fichero ya no existe. Eso no es caducidad, es
      // desincronizacion, y de eso ya informan `validate` y `prune`.
      if (actual && actual !== node.verified.fingerprint) {
        stale.push({
          id: node.id,
          file: node.file,
          since: node.verified.commit ?? node.verified.date,
          last: git ? lastCommitFor(root, node.file) : null,
        });
      }
      continue;
    }
    // Hecho antiguo, sellado antes de que existieran las huellas: se cae al
    // mecanismo de git, que es el unico dato que tiene.
    if (!node.verified.commit || !git) {
      unverified.push(node);
      continue;
    }
    if (!porCommit.has(node.verified.commit)) porCommit.set(node.verified.commit, []);
    porCommit.get(node.verified.commit).push(node);
  }

  // Se pregunta a git una vez por commit y no una por hecho: con miles de
  // hechos la diferencia es de segundos a milisegundos, y esto corre en CI.
  for (const [commit, nodes] of porCommit) {
    const cambiados = filesChangedSince(root, commit);
    if (!cambiados) continue;
    for (const node of nodes) {
      if (!cambiados.has(node.file)) continue;
      stale.push({ id: node.id, file: node.file, since: commit, last: lastCommitFor(root, node.file) });
    }
  }
  stale.sort((a, b) => a.id.localeCompare(b.id));

  if (options.json) return { output: JSON.stringify({ stale, unverified: unverified.map((n) => n.id) }, null, 2) };

  const lines = [];
  if (stale.length) {
    lines.push(`${stale.length} hecho(s) por revisar (el codigo cambio despues de verificarlos):`);
    stale.forEach((entry) => lines.push(`  ${entry.id}\n    ${entry.file}  ${entry.since}${entry.last ? ` -> ${entry.last}` : ''}`));
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
