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

/** Recorta una lista de aristas y devuelve las lineas del resumen omitido. */
function renderEdgeList(edges, direction, limit) {
  const cap = limit > 0 ? limit : edges.length;
  const lines = edges.slice(0, cap).map((edge) => formatEdge(edge, { direction }));
  if (edges.length > cap) {
    const resto = edges.slice(cap);
    lines.push(`  ... y ${resto.length} mas: ${typeHistogram(resto)}`);
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
    const cap = limit > 0 ? limit : total;
    // Las ocultas a grep van primero (impact ya las ordena asi), de modo que si
    // hay que recortar se conservan justo las que nadie encontraria por su cuenta.
    const shown = level.entries.slice(0, cap);
    const header = level.depth === 1 ? 'DEPENDEN DIRECTAMENTE' : `A ${level.depth} SALTOS`;
    lines.push('', `${header} (${total}):`);

    for (const entry of shown) {
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

    if (total > shown.length) {
      const resto = level.entries.slice(shown.length);
      const ocultas = resto.filter((entry) => entry.hidden).length;
      lines.push(
        `  ... y ${resto.length} mas${ocultas ? ` (${ocultas} ocultas a grep)` : ''}: ${typeHistogram(resto)}`,
      );
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
