/**
 * Consulta y presentacion compacta del indice.
 *
 * Aqui es donde Edgelore ahorra tokens o deja de hacerlo. La regla de diseno es
 * unica y no negociable: una consulta devuelve SOLO el vecindario pedido, nunca
 * el indice entero. Un volcado completo dentro del contexto gastaria mas tokens
 * de los que ahorra, que es exactamente el fallo de meter las referencias en un
 * AGENTS.md que se carga en cada sesion.
 */

import { incomingEdges } from './store.js';

const CONFIDENCE_MARK = { certain: '', likely: ' ~probable', unverified: ' ~SIN VERIFICAR' };

/** Las aristas que grep no puede encontrar: el motivo por el que existe Edgelore. */
const HIDDEN_TYPES = new Set(['string-ref', 'lifecycle', 'event', 'config', 'schedules', 'affects']);

export function isHiddenEdge(edge) {
  return HIDDEN_TYPES.has(edge.type);
}

/**
 * Cuantas dependencias se listan por nivel antes de resumir.
 *
 * Sin tope, un nodo del que dependen cientos de cosas -un servicio de auditoria,
 * una tabla compartida- produce miles de tokens en una sola consulta y el indice
 * pasa a costar mas de lo que ahorra. Ademas `impact` alimenta el hook previo a
 * la edicion, que se dispara solo: ahi el tope no es una comodidad, es lo que
 * impide inyectar contexto que nadie ha pedido.
 *
 * Cuando se recorta, se muestra el recuento por tipo. Para decidir si un cambio
 * es arriesgado, "380 cosas leen esto" es el dato accionable; los nombres solo
 * importan si vas a inspeccionarlos, y para eso esta --all.
 */
const DEFAULT_LEVEL_LIMIT = 12;
/** Cuantos grupos modulo+tipo se listan antes de resumirlos tambien. */
const GROUP_LIMIT = 10;

/**
 * Modulo al que pertenece un id, por convencion de nombres jerarquicos:
 * `Erp.Ventas.Pagina7.OnAppearing` -> `Erp.Ventas`, `Auditoria` -> `Auditoria`.
 */
export function moduleOf(id) {
  const parts = String(id).split('.');
  return parts.length <= 2 ? parts[0] : parts.slice(0, 2).join('.');
}

/**
 * Agrupa dependientes por tipo de arista y modulo, de mayor a menor.
 *
 * En un producto con libreria, proyecto base y verticales encima, listar los
 * primeros N nombres es peor que inutil: el orden alfabetico hace que salgan
 * todos del mismo modulo y quien lo lee concluye que el cambio solo afecta a
 * ese. El dato que permite decidir que probar es cuantos hay en cada modulo.
 */
function groupByModule(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const modulo = moduleOf(entry.id);
    const key = `${entry.type}|${modulo}`;
    if (!groups.has(key)) groups.set(key, { type: entry.type, modulo, items: [] });
    groups.get(key).items.push(entry);
  }
  return [...groups.values()].sort(
    (a, b) => b.items.length - a.items.length || a.modulo.localeCompare(b.modulo),
  );
}

function typeHistogram(entries) {
  const counts = {};
  for (const entry of entries) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type} ${count}`)
    .join(', ');
}

function formatEdge(edge, { direction }) {
  const peer = direction === 'in' ? edge.from : edge.to;
  const parts = [`  ${edge.type.padEnd(11)} ${peer}`];
  const detail = [];
  if (edge.trigger) detail.push(`disparado por: ${edge.trigger}`);
  if (edge.at) detail.push(`en ${edge.at}`);
  if (edge.note) detail.push(edge.note);
  if (edge.source && edge.source !== 'human') detail.push(`via ${edge.source}`);
  const mark = CONFIDENCE_MARK[edge.confidence ?? 'unverified'] ?? '';
  if (detail.length) parts.push(`\n${' '.repeat(14)}${detail.join(' | ')}`);
  return parts.join('') + mark;
}

/**
 * Vecindario de un nodo: el nodo, lo que sale de el y lo que apunta hacia el.
 * Las entrantes son la mitad que responde a "quien ejecuta esto", que es
 * justo la pregunta que grep no sabe contestar.
 */
export function neighbourhood(index, id) {
  const node = index.nodes.get(id) ?? null;
  const incoming = incomingEdges(index, id);
  if (!node && incoming.length === 0) return null;
  return { id, node, outgoing: node?.edges ?? [], incoming };
}

/**
 * Lista las aristas, o las reparte por modulo cuando son demasiadas. Mismo
 * criterio que en `impact`: con muchos vecinos, el reparto informa y la lista
 * recortada engana.
 */
function renderEdgeList(edges, direction, limit) {
  if (limit <= 0 || edges.length <= limit) {
    return edges.map((edge) => formatEdge(edge, { direction }));
  }
  const groups = groupByModule(edges.map((edge) => ({
    id: direction === 'in' ? edge.from : edge.to,
    type: edge.type,
    hidden: isHiddenEdge(edge),
  })));
  const ancho = String(edges.length).length;
  const lines = [`  reparto por modulo (${edges.length}):`];
  for (const group of groups.slice(0, GROUP_LIMIT)) {
    lines.push(
      `  ${group.type.padEnd(11)} ${group.modulo.padEnd(20)} ${String(group.items.length).padStart(ancho)}` +
        `   ej. ${group.items[0].id}`,
    );
  }
  if (groups.length > GROUP_LIMIT) {
    const resto = groups.slice(GROUP_LIMIT);
    lines.push(`  ... y ${resto.reduce((n, g) => n + g.items.length, 0)} en ${resto.length} grupo(s) mas`);
  }
  return lines;
}

export function renderNeighbourhood(result, { notes = true, limit = DEFAULT_LEVEL_LIMIT } = {}) {
  const lines = [];
  const { id, node, outgoing, incoming } = result;

  if (node) {
    lines.push(`${id}${node.kind ? `  [${node.kind}]` : ''}`);
    if (node.file) lines.push(`  archivo: ${node.file}`);
    if (node.summary) lines.push(`  ${node.summary}`);
    if (node.tags?.length) lines.push(`  tags: ${node.tags.join(', ')}`);
    if (node.verified?.commit) {
      lines.push(`  verificado: ${node.verified.commit}${node.verified.date ? ` (${node.verified.date})` : ''}`);
    }
  } else {
    lines.push(`${id}  [sin ficha propia]`);
    lines.push('  Referenciado por otros hechos pero aun no registrado.');
  }

  if (outgoing.length) {
    lines.push('', `SALE HACIA (${outgoing.length}):`);
    lines.push(...renderEdgeList(outgoing, 'out', limit));
  }

  if (incoming.length) {
    lines.push('', `LLEGA DESDE (${incoming.length}):`);
    lines.push(...renderEdgeList(incoming, 'in', limit));
  }

  if (!outgoing.length && !incoming.length) {
    lines.push('', 'Sin aristas registradas todavia.');
  }

  if (notes && node?.notes) lines.push('', 'NOTAS:', node.notes);
  return lines.join('\n');
}

/**
 * Busqueda por texto sobre id, summary, tags y notas. Es deliberadamente
 * literal: sin embeddings, sin ranking opaco. Quien consulta necesita saber por
 * que ha salido cada resultado.
 */
export function search(index, term, { limit = 20 } = {}) {
  const needle = term.toLowerCase();
  const hits = [];

  for (const node of index.nodes.values()) {
    const haystacks = [
      ['id', node.id],
      ['summary', node.summary],
      ['tags', node.tags?.join(' ')],
      ['notas', node.notes],
    ];
    const matched = haystacks.filter(([, text]) => text && text.toLowerCase().includes(needle));
    if (!matched.length) continue;
    // Coincidir en el id es una senal mucho mas fuerte que coincidir en las notas.
    const score = matched.some(([field]) => field === 'id') ? 0 : 1;
    hits.push({ id: node.id, summary: node.summary, where: matched.map(([field]) => field), score });
  }

  return hits.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/** Distancia de edicion acotada: si supera `max`, corta y devuelve Infinity. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return Infinity;
  let previa = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const fila = [i];
    let minimo = i;
    for (let j = 1; j <= b.length; j += 1) {
      const coste = a[i - 1] === b[j - 1] ? 0 : 1;
      fila[j] = Math.min(previa[j] + 1, fila[j - 1] + 1, previa[j - 1] + coste);
      if (fila[j] < minimo) minimo = fila[j];
    }
    if (minimo > max) return Infinity;
    previa = fila;
  }
  return previa[b.length];
}

/**
 * Ids parecidos al que se pidio, para cuando no existe.
 *
 * `search` solo casa subcadenas, asi que ante una errata -"Pagna7" por
 * "Pagina7"- no devolvia nada: la sugerencia existia pero fallaba justo en el
 * caso que la justifica. Se compara tambien contra el ultimo segmento, porque
 * es habitual escribir el nombre corto sin el espacio de nombres.
 */
export function suggest(index, id, { limit = 3 } = {}) {
  const objetivo = id.toLowerCase();
  const cola = objetivo.split('.').pop();
  // El nombre corto se compara con tolerancia mas estrecha que el id completo:
  // con la misma, "PageBase" casaba con "Pagina0" y colaba ruido evidente.
  const tolTotal = Math.max(2, Math.floor(objetivo.length * 0.34));
  const tolCola = Math.max(1, Math.floor(cola.length * 0.25));
  const candidatos = [];

  for (const candidato of new Set([...index.nodes.keys(), ...index.incoming.keys()])) {
    const bajo = candidato.toLowerCase();
    const total = editDistance(objetivo, bajo, tolTotal);
    const parcial = editDistance(cola, bajo.split('.').pop(), tolCola);
    const distancia = Math.min(total, parcial);
    if (distancia !== Infinity) candidatos.push({ id: candidato, distancia, total });
  }

  // A igualdad de parecido en el nombre corto gana quien tambien se parece en
  // el id completo: si no, "Erp.Ventas.Pagna7" proponia el Pagina7 de los otros
  // tres modulos antes que el de Ventas, que es justo el que se buscaba.
  return candidatos
    .sort((a, b) => a.distancia - b.distancia || a.total - b.total || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((entry) => entry.id);
}

/** Ids parecidos, por subcadena primero y por parecido si no hay ninguno. */
export function didYouMean(index, id, { limit = 3 } = {}) {
  const porTexto = search(index, id, { limit }).map((hit) => hit.id);
  return porTexto.length ? porTexto : suggest(index, id, { limit });
}

export function renderSearch(hits, term) {
  if (!hits.length) return `Sin resultados para "${term}".`;
  return hits
    .map((hit) => `${hit.id}  (${hit.where.join(', ')})${hit.summary ? `\n  ${hit.summary}` : ''}`)
    .join('\n');
}

/**
 * Camino mas corto entre dos nodos recorriendo aristas en ambos sentidos.
 * Responde a "como llega A hasta B", que en la practica es la pregunta cara:
 * sin indice implica abrir media docena de ficheros para reconstruirla.
 */
export function path(index, fromId, toId, { maxDepth = 6 } = {}) {
  if (fromId === toId) return [];
  const queue = [[fromId, []]];
  const seen = new Set([fromId]);

  while (queue.length) {
    const [current, trail] = queue.shift();
    if (trail.length >= maxDepth) continue;

    const outgoing = (index.nodes.get(current)?.edges ?? []).map((edge) => ({
      peer: edge.to,
      step: { from: current, to: edge.to, type: edge.type, trigger: edge.trigger, direction: 'out' },
    }));
    const incoming = incomingEdges(index, current).map((edge) => ({
      peer: edge.from,
      step: { from: edge.from, to: current, type: edge.type, trigger: edge.trigger, direction: 'in' },
    }));

    for (const { peer, step } of [...outgoing, ...incoming]) {
      if (seen.has(peer)) continue;
      const next = [...trail, step];
      if (peer === toId) return next;
      seen.add(peer);
      queue.push([peer, next]);
    }
  }
  return null;
}

export function renderPath(steps, fromId, toId) {
  if (steps === null) return `No hay camino conocido entre ${fromId} y ${toId} en el indice.`;
  if (steps.length === 0) return `${fromId} y ${toId} son el mismo nodo.`;
  const lines = [`${fromId}`];
  for (const step of steps) {
    const arrow = step.direction === 'out' ? '-->' : '<--';
    const peer = step.direction === 'out' ? step.to : step.from;
    lines.push(`  ${arrow} [${step.type}]${step.trigger ? ` ${step.trigger}` : ''}`);
    lines.push(`${peer}`);
  }
  return lines.join('\n');
}

/**
 * Alcance de un cambio: todo lo que depende del nodo, directa o indirectamente.
 *
 * Es la pregunta real antes de tocar algo -"que se rompe si cambio esto"- y no
 * la contesta ni `query`, que solo ve vecinos directos, ni `path`, que exige
 * conocer el destino de antemano. Se recorre hacia atras porque lo que importa
 * es quien depende de ti, no de quien dependes tu.
 */
export function impact(index, id, { maxDepth = 4 } = {}) {
  const levels = [];
  // Profundidad a la que se alcanzo cada nodo por primera vez. Cada dependiente
  // se reporta UNA sola vez, a su distancia mas corta: volver a listarlo mas
  // abajo solo infla la salida sin anadir informacion, y la distancia corta es
  // la que importa para juzgar el riesgo.
  const reachedAt = new Map([[id, 0]]);
  const recorded = new Set();
  let frontier = [id];

  for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
    const next = [];
    const entries = [];

    for (const current of frontier) {
      for (const edge of incomingEdges(index, current)) {
        const previo = reachedAt.get(edge.from);
        if (previo !== undefined && previo < depth) continue;

        // Dentro de un mismo nivel si se admiten varias aristas hacia el mismo
        // nodo: son motivos distintos por los que un cambio puede romperlo.
        const key = `${edge.from}|${current}|${edge.type}`;
        if (!recorded.has(key)) {
          recorded.add(key);
          entries.push({
            id: edge.from,
            // La ruta es lo que convierte el alcance en una lista de trabajo:
            // sin ella hay que resolver cada id por separado para saber que abrir.
            file: index.nodes.get(edge.from)?.file ?? null,
            via: current === id ? null : current,
            type: edge.type,
            trigger: edge.trigger,
            at: edge.at,
            note: edge.note,
            confidence: edge.confidence ?? 'unverified',
            hidden: isHiddenEdge(edge),
          });
        }
        if (!reachedAt.has(edge.from)) {
          reachedAt.set(edge.from, depth);
          next.push(edge.from);
        }
      }
    }

    if (entries.length) {
      entries.sort((a, b) => Number(b.hidden) - Number(a.hidden) || a.id.localeCompare(b.id));
      levels.push({ depth, entries });
    }
    frontier = next;
  }

  const hidden = levels.reduce((total, level) => total + level.entries.filter((e) => e.hidden).length, 0);
  return { id, levels, affected: reachedAt.size - 1, hidden, truncated: frontier.length > 0, known: index.nodes.has(id) };
}

export function renderImpact(result, index, { limit = DEFAULT_LEVEL_LIMIT } = {}) {
  const lines = [`ALCANCE DE ${result.id}`];

  if (!result.known) {
    lines.push('  Este nodo no tiene ficha propia en el indice.');
  }
  if (result.affected === 0) {
    lines.push('', 'Nada registrado depende de el.');
    lines.push('');
    lines.push(coverageWarning(index));
    return lines.join('\n');
  }

  lines.push(
    `  ${result.affected} nodo(s) dependen de el` +
      (result.hidden ? `, ${result.hidden} por relaciones que grep NO encuentra` : ''),
  );

  for (const level of result.levels) {
    const total = level.entries.length;
    const header = level.depth === 1 ? 'DEPENDEN DIRECTAMENTE' : `A ${level.depth} SALTOS`;

    // Pocos dependientes: se listan uno a uno, con todo el detalle.
    if (limit <= 0 || total <= limit) {
      lines.push('', `${header} (${total}):`);
      for (const entry of level.entries) {
        const mark = entry.hidden ? ' <- OCULTA A GREP' : '';
        const doubt = entry.confidence === 'certain' ? '' : ` ~${entry.confidence}`;
        lines.push(`  ${entry.type.padEnd(11)} ${entry.id}${mark}${doubt}`);
        const detail = [];
        if (entry.via) detail.push(`a traves de ${entry.via}`);
        if (entry.trigger) detail.push(entry.trigger);
        if (entry.at) detail.push(`en ${entry.at}`);
        if (entry.note) detail.push(entry.note);
        if (detail.length) lines.push(`${' '.repeat(14)}${detail.join(' | ')}`);
      }
      continue;
    }

    // Muchos: el reparto por modulo dice lo que hay que probar; una lista de
    // nombres recortada solo diria de que modulo empiezan por la "a".
    const groups = groupByModule(level.entries);
    lines.push('', `${header} (${total}) - reparto por modulo:`);
    for (const group of groups.slice(0, GROUP_LIMIT)) {
      const ocultas = group.items.filter((item) => item.hidden).length;
      const marca = ocultas === group.items.length ? '  <- OCULTAS A GREP' : ocultas ? `  (${ocultas} ocultas)` : '';
      const ancho = String(total).length;
      lines.push(
        `  ${group.type.padEnd(11)} ${group.modulo.padEnd(20)} ${String(group.items.length).padStart(ancho)}` +
          `   ej. ${group.items[0].id}${marca}`,
      );
    }
    if (groups.length > GROUP_LIMIT) {
      const resto = groups.slice(GROUP_LIMIT);
      const nodos = resto.reduce((suma, group) => suma + group.items.length, 0);
      lines.push(`  ... y ${nodos} en ${resto.length} grupo(s) mas: ${resto.slice(0, 8).map((g) => g.modulo).join(', ')}`);
    }

    // El disparador suele ser identico en todo el grupo (lo pone la misma regla):
    // repetirlo por cada linea es puro relleno.
    const triggers = new Set(level.entries.map((entry) => entry.trigger).filter(Boolean));
    if (triggers.size === 1 && level.entries.every((entry) => entry.trigger)) {
      lines.push(`${' '.repeat(14)}todas disparadas por: ${[...triggers][0]}`);
    }
  }

  if (result.truncated) {
    lines.push('', 'Hay mas dependencias mas alla de la profundidad consultada. Usa --depth para ampliar.');
  }
  if (limit > 0 && result.levels.some((level) => level.entries.length > limit)) {
    lines.push('Listado recortado. Para verlo entero: --all (o --json para procesarlo).');
  }
  lines.push('', coverageWarning(index));
  return lines.join('\n');
}

/**
 * Lista de trabajo: los sitios concretos que hay que revisar al hacer el cambio.
 *
 * Distinta de `renderImpact`, que sirve para orientarse y esta acotada. Esto es
 * lo contrario: una peticion explicita del listado completo, deduplicado POR
 * FICHERO, porque lo que se abre es un fichero y varios nodos suelen vivir en el
 * mismo. Se acota con --module y --depth, no recortando la lista: una lista de
 * trabajo a la que le faltan sitios no sirve para nada.
 */
export function workList(result, { module: modulo = null, maxDepth = Infinity } = {}) {
  const porFichero = new Map();
  let sinFichero = 0;

  for (const level of result.levels) {
    if (level.depth > maxDepth) continue;
    for (const entry of level.entries) {
      if (modulo && !entry.id.startsWith(modulo)) continue;
      if (!entry.file) {
        sinFichero += 1;
        continue;
      }
      if (!porFichero.has(entry.file)) porFichero.set(entry.file, []);
      porFichero.get(entry.file).push({ ...entry, depth: level.depth });
    }
  }

  const files = [...porFichero.entries()]
    .map(([file, items]) => ({
      file,
      items,
      depth: Math.min(...items.map((item) => item.depth)),
      hidden: items.some((item) => item.hidden),
    }))
    // Primero lo mas cercano al cambio, y dentro de eso lo que grep no encuentra.
    .sort((a, b) => a.depth - b.depth || Number(b.hidden) - Number(a.hidden) || a.file.localeCompare(b.file));

  return { files, sinFichero, total: files.reduce((n, entry) => n + entry.items.length, 0) };
}

export function renderWorkList(result, lista, { module: modulo = null } = {}) {
  if (!lista.files.length) {
    const extra = lista.sinFichero ? ` (${lista.sinFichero} dependiente(s) sin fichero declarado)` : '';
    return `Sin ficheros que revisar para ${result.id}${modulo ? ` en ${modulo}` : ''}.${extra}`;
  }

  const lines = [
    `SITIOS A REVISAR al cambiar ${result.id}${modulo ? `  [solo ${modulo}]` : ''}`,
    `  ${lista.files.length} fichero(s), ${lista.total} dependiente(s)`,
    '',
  ];

  for (const entry of lista.files) {
    const tipos = [...new Set(entry.items.map((item) => item.type))].join(', ');
    const marca = entry.hidden ? '  <- OCULTA A GREP' : '';
    lines.push(`${entry.file}`);
    lines.push(`  d${entry.depth}  ${tipos}${marca}  ${entry.items.map((item) => item.id).join(', ')}`);
    // El sitio exacto del literal, cuando se registro: evita releer el fichero entero.
    for (const item of entry.items) {
      if (item.at) lines.push(`      literal en ${item.at}`);
    }
  }

  if (lista.sinFichero) {
    lines.push('', `${lista.sinFichero} dependiente(s) sin fichero declarado en el indice (tabla, config, disparador externo).`);
  }
  return lines.join('\n');
}

/**
 * Nunca se devuelve un alcance sin este aviso. Un indice curado solo conoce lo
 * que alguien registro, y presentar su respuesta como una garantia de que nada
 * se rompe seria justo la clase de mentira que este proyecto existe para
 * evitar.
 */
function coverageWarning(index) {
  const summary = stats(index);
  return (
    `El indice conoce ${summary.nodes} nodo(s) y ${summary.edges} arista(s). ` +
    'Cubre lo que el equipo ha registrado, no todo lo que existe: ' +
    'complementa esta respuesta con grep para las llamadas explicitas.'
  );
}

export function stats(index) {
  const byType = {};
  const bySource = {};
  const byConfidence = {};
  let hidden = 0;
  let edges = 0;

  for (const node of index.nodes.values()) {
    for (const edge of node.edges ?? []) {
      edges += 1;
      byType[edge.type] = (byType[edge.type] ?? 0) + 1;
      bySource[edge.source ?? 'human'] = (bySource[edge.source ?? 'human'] ?? 0) + 1;
      byConfidence[edge.confidence ?? 'unverified'] = (byConfidence[edge.confidence ?? 'unverified'] ?? 0) + 1;
      if (isHiddenEdge(edge)) hidden += 1;
    }
  }

  return { nodes: index.nodes.size, edges, hidden, byType, bySource, byConfidence };
}

export function renderStats(summary, { dangling = [] } = {}) {
  const lines = [
    `nodos:   ${summary.nodes}`,
    `aristas: ${summary.edges}`,
    // Es la metrica que importa: las explicitas ya las encuentra un grep.
    `  de las cuales ocultas a grep: ${summary.hidden}`,
  ];
  const section = (title, data) => {
    const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return;
    lines.push('', title);
    entries.forEach(([key, count]) => lines.push(`  ${key.padEnd(14)} ${count}`));
  };
  section('por tipo:', summary.byType);
  section('por confianza:', summary.byConfidence);
  section('por origen:', summary.bySource);
  if (dangling.length) {
    lines.push('', `referenciados sin ficha propia (${dangling.length}):`);
    dangling.slice(0, 20).forEach((id) => lines.push(`  ${id}`));
    if (dangling.length > 20) lines.push(`  ... y ${dangling.length - 20} mas`);
  }
  return lines.join('\n');
}
