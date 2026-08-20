/**
 * Comandos de escritura: add, link, verify, remove.
 *
 * Registrar un hecho tiene que costar una sola orden. El momento en que un
 * hallazgo es barato de registrar es justo despues de descubrirlo: quien acaba
 * de investigarlo ya tiene la respuesta delante. Si registrarlo cuesta abrir un
 * fichero y recordar un esquema, no se hace, y el indice muere.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadIndex, readNode, requireStoreRoot, writeNode, nodePath } from '../store.js';
import { normalizeEdge, validateNode, EDGE_TYPES, CONFIDENCE } from '../model.js';
import { loadRules, kindCatalog, implicitEdgesFor, checklistFor, renderChecklist } from '../rules.js';
import { headCommit, currentUser, isGitRepo } from '../git.js';

/** Parsea `--edge destino:tipo:nota` en una arista normalizada. */
export function parseEdgeFlag(raw) {
  const parts = String(raw).split(':');
  const to = parts.shift()?.trim();
  const type = parts.shift()?.trim();
  const rest = parts.join(':').trim();
  if (!to || !type) {
    throw new Error(`--edge invalido: "${raw}". Formato: destino:tipo[:nota]`);
  }
  if (!EDGE_TYPES[type]) {
    throw new Error(`Tipo de arista "${type}" desconocido.\nValidos: ${Object.keys(EDGE_TYPES).join(', ')}`);
  }
  const edge = { to, type };
  // Las implicitas necesitan un disparador; la nota suelta hace ese papel.
  if (rest) {
    if (type === 'lifecycle' || type === 'schedules') edge.trigger = rest;
    else if (type === 'string-ref') edge.note = rest;
    else edge.note = rest;
  }
  return edge;
}

function verificationStamp(root, options) {
  if (options.unverified) return undefined;
  if (!isGitRepo(root)) return undefined;
  const commit = headCommit(root);
  if (!commit) return undefined;
  const stamp = { commit, date: new Date().toISOString().slice(0, 10) };
  const by = currentUser(root);
  if (by) stamp.by = by;
  return stamp;
}

export function cmdAdd(args, options) {
  const id = args[0];
  if (!id) throw new Error('Uso: edgelore add <id> [--file <ruta>] [--kind <kind>] [--edge destino:tipo:nota]');
  const root = requireStoreRoot();
  const existing = readNode(root, id);
  const catalog = kindCatalog(loadRules(root));

  const node = existing ? { ...existing } : { id, edges: [] };
  delete node.notes;
  delete node._file;
  // El id lo manda siempre el argumento, nunca el fichero leido: asi un
  // fichero que no corresponda al id pedido no se edita por confusion.
  node.id = id;

  if (options.file) node.file = options.file;
  if (options.kind) node.kind = options.kind;
  if (options.summary) node.summary = options.summary;
  if (options.lang) node.lang = options.lang;
  if (options.tag?.length) node.tags = [...(node.tags ?? []), ...options.tag];

  if (options.confidence && !CONFIDENCE[options.confidence]) {
    throw new Error(`Confianza "${options.confidence}" desconocida.\nValidas: ${Object.keys(CONFIDENCE).join(', ')}`);
  }
  // Las aristas de --edge nacen sin verificar salvo que se afirme lo contrario:
  // se escriben de corrido y marcarlas como comprobadas por defecto seria
  // exactamente como el indice empieza a mentir.
  const edges = [...(node.edges ?? [])];
  for (const raw of options.edge ?? []) {
    edges.push({ ...parseEdgeFlag(raw), confidence: options.confidence ?? 'unverified' });
  }

  // Las aristas implicitas del framework se generan solas: declarar el kind una
  // vez ahorra escribirlas a mano en cada pagina o cada servicio.
  const applied = [];
  if (node.kind && !options['no-rules']) {
    const implicit = implicitEdgesFor(catalog, id, node.kind);
    for (const edge of implicit) {
      if (!edges.some((existing) => existing.to === edge.to && existing.type === edge.type)) {
        edges.push(edge);
        applied.push(edge);
      }
    }
  }
  node.edges = edges.map(normalizeEdge);

  const stamp = verificationStamp(root, options);
  if (stamp) node.verified = stamp;

  const problems = validateNode(node, { source: id });
  if (problems.length) return { output: problems.join('\n'), code: 1 };

  const notes = options.note ?? existing?.notes ?? '';
  const file = writeNode(root, node, notes);

  const lines = [`${existing ? 'Actualizado' : 'Registrado'}: ${id}`, `  ${path.relative(root, file)}`];
  if (applied.length) {
    lines.push('', `Aristas anadidas por la regla del kind "${node.kind}":`);
    applied.forEach((edge) => lines.push(`  ${edge.type.padEnd(11)} ${edge.to}`));
  }
  if (node.kind && !catalog.has(node.kind)) {
    lines.push('', `Aviso: el kind "${node.kind}" no esta declarado en ninguna regla. Ejecuta \`edgelore kinds\`.`);
  }
  const checklist = node.kind ? checklistFor(catalog, node.kind) : null;
  if (checklist?.items.length) lines.push('', renderChecklist(checklist));
  return { output: lines.join('\n') };
}

/** Anade una arista a un hecho existente sin tocar el resto de sus campos. */
export function cmdLink(args, options) {
  const [from, to, type] = args;
  if (!from || !to || !type) {
    throw new Error(`Uso: edgelore link <origen> <destino> <tipo> [--trigger "..."] [--at fichero:linea] [--note "..."]

Tipos disponibles:
${Object.entries(EDGE_TYPES).map(([key, help]) => `  ${key.padEnd(11)} ${help}`).join('\n')}`);
  }
  if (!EDGE_TYPES[type]) {
    throw new Error(`Tipo "${type}" desconocido.\nValidos: ${Object.keys(EDGE_TYPES).join(', ')}`);
  }
  if (options.confidence && !CONFIDENCE[options.confidence]) {
    throw new Error(`Confianza "${options.confidence}" desconocida.\nValidas: ${Object.keys(CONFIDENCE).join(', ')}`);
  }

  const root = requireStoreRoot();
  const existing = readNode(root, from);
  const node = existing ? { ...existing } : { id: from, edges: [] };
  delete node.notes;
  delete node._file;
  node.id = from;

  const edge = normalizeEdge({
    to,
    type,
    confidence: options.confidence ?? 'certain',
    trigger: options.trigger,
    at: options.at,
    note: options.note,
  });

  const edges = (node.edges ?? []).filter((current) => !(current.to === to && current.type === type));
  edges.push(edge);
  node.edges = edges;

  const stamp = verificationStamp(root, options);
  if (stamp) node.verified = stamp;

  const problems = validateNode(node, { source: from });
  if (problems.length) return { output: problems.join('\n'), code: 1 };

  writeNode(root, node, existing?.notes ?? '');
  const index = loadIndex(root);
  const warning = index.nodes.has(to) ? '' : `\nAviso: "${to}" aun no tiene ficha propia. Registralo con \`edgelore add ${to}\`.`;
  return { output: `${from} --[${type}]--> ${to}${warning}` };
}

/** Vuelve a sellar un hecho como comprobado en el commit actual. */
export function cmdVerify(args) {
  const id = args[0];
  if (!id) throw new Error('Uso: edgelore verify <id>');
  const root = requireStoreRoot();
  const existing = readNode(root, id);
  if (!existing) return { output: `No existe ningun hecho con id "${id}".`, code: 1 };
  if (!isGitRepo(root)) return { output: 'Este directorio no es un repositorio git.', code: 1 };

  const node = { ...existing };
  const notes = node.notes ?? '';
  delete node.notes;
  delete node._file;
  node.verified = verificationStamp(root, {});
  writeNode(root, node, notes);
  return { output: `${id} verificado en ${node.verified.commit} (${node.verified.date}).` };
}

export function cmdRemove(args, options) {
  const id = args[0];
  if (!id) throw new Error('Uso: edgelore remove <id>');
  const root = requireStoreRoot();
  const file = nodePath(root, id);
  if (!fs.existsSync(file)) return { output: `No existe ningun hecho con id "${id}".`, code: 1 };

  const index = loadIndex(root);
  const referrers = (index.incoming.get(id) ?? []).map((edge) => edge.from);
  if (referrers.length && !options.force) {
    return {
      output: `"${id}" esta referenciado por ${referrers.length} hecho(s):\n${referrers.map((r) => `  ${r}`).join('\n')}\n\nQuedarian aristas apuntando a un nodo sin ficha. Usa --force si aun asi quieres borrarlo.`,
      code: 1,
    };
  }
  fs.unlinkSync(file);
  return { output: `Eliminado: ${id}` };
}
