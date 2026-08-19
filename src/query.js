/**
 * Consulta y presentacion compacta del indice.
 *
 * Aqui es donde Nexo ahorra tokens o deja de hacerlo. La regla de diseno es
 * unica y no negociable: una consulta devuelve SOLO el vecindario pedido, nunca
 * el indice entero. Un volcado completo dentro del contexto gastaria mas tokens
 * de los que ahorra, que es exactamente el fallo de meter las referencias en un
 * AGENTS.md que se carga en cada sesion.
 */

import { incomingEdges } from './store.js';

const CONFIDENCE_MARK = { certain: '', likely: ' ~probable', unverified: ' ~SIN VERIFICAR' };

/** Las aristas que grep no puede encontrar: el motivo por el que existe Nexo. */
const HIDDEN_TYPES = new Set(['string-ref', 'lifecycle', 'event', 'config', 'schedules', 'affects']);

export function isHiddenEdge(edge) {
  return HIDDEN_TYPES.has(edge.type);
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

export function renderNeighbourhood(result, { notes = true } = {}) {
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
    outgoing.forEach((edge) => lines.push(formatEdge(edge, { direction: 'out' })));
  }

  if (incoming.length) {
    lines.push('', `LLEGA DESDE (${incoming.length}):`);
    incoming.forEach((edge) => lines.push(formatEdge(edge, { direction: 'in' })));
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
