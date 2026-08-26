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
import { normalizeEdge, validateNode, isValidId, EDGE_TYPES, CONFIDENCE } from '../model.js';
import { loadRules, kindCatalog, implicitEdgesFor, checklistFor, renderChecklist } from '../rules.js';
import { headCommit, currentUser, isGitRepo } from '../git.js';
import { fingerprintFile } from '../fingerprint.js';
import { captureAnchor } from '../anchor.js';

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

/**
 * Sella un hecho como comprobado ahora.
 *
 * El mecanismo es la huella del fichero que el hecho describe; git solo
 * enriquece. Antes era al reves y eso dejaba sin sello -y por tanto fuera del
 * alcance de `stale`- todo hecho escrito fuera de un repositorio git.
 *
 * Un nodo sin fichero (una tabla, una clave de configuracion, un disparador
 * externo) no tiene contenido que resumir: se sella igual con la fecha, porque
 * "alguien afirmo esto el dia tal" sigue siendo informacion, aunque `stale` no
 * pueda comprobarlo despues.
 */
function verificationStamp(root, options, file) {
  if (options.unverified) return undefined;
  const stamp = {};
  const fingerprint = fingerprintFile(root, file);
  if (fingerprint) stamp.fingerprint = fingerprint;
  if (isGitRepo(root)) {
    const commit = headCommit(root);
    if (commit) stamp.commit = commit;
    const by = currentUser(root);
    if (by) stamp.by = by;
  }
  stamp.date = new Date().toISOString().slice(0, 10);
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

  const stamp = verificationStamp(root, options, node.file);
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

  // El ancla se captura sola de la linea indicada. Si hubiera que escribirla a
  // mano no la escribiria nadie, y una funcion que depende de que alguien se
  // acuerde de usarla es una funcion que no existe. `--anchor` sigue estando
  // para cuando la linea no es el mejor identificador (una llave suelta, por
  // ejemplo) o cuando se registra sin tener el fichero delante.
  const at = options.at;
  const anchor = options.anchor ?? (at ? captureAnchor(root, at) : null);

  const edge = normalizeEdge({
    to,
    type,
    confidence: options.confidence ?? 'certain',
    trigger: options.trigger,
    at,
    anchor: anchor ?? undefined,
    note: options.note,
  });

  const edges = (node.edges ?? []).filter((current) => !(current.to === to && current.type === type));
  edges.push(edge);
  node.edges = edges;

  const stamp = verificationStamp(root, options, node.file);
  if (stamp) node.verified = stamp;

  const problems = validateNode(node, { source: from });
  if (problems.length) return { output: problems.join('\n'), code: 1 };

  writeNode(root, node, existing?.notes ?? '');
  // Basta con mirar si existe la ficha del destino: cargar el indice entero
  // para un aviso de una linea son miles de lecturas de fichero, y `link` es de
  // los comandos que mas se repiten al dia.
  const warning = readNode(root, to)
    ? ''
    : `\nAviso: "${to}" aun no tiene ficha propia. Registralo con \`edgelore add ${to}\`.`;
  return { output: `${from} --[${type}]--> ${to}${warning}` };
}

/** Vuelve a sellar un hecho como comprobado en el commit actual. */
export function cmdVerify(args) {
  const id = args[0];
  if (!id) throw new Error('Uso: edgelore verify <id>');
  const root = requireStoreRoot();
  const existing = readNode(root, id);
  if (!existing) return { output: `No existe ningun hecho con id "${id}".`, code: 1 };

  const node = { ...existing };
  const notes = node.notes ?? '';
  delete node.notes;
  delete node._file;
  node.verified = verificationStamp(root, {}, node.file);
  writeNode(root, node, notes);

  // Se dice con que ha quedado sellado, porque no siempre es lo mismo: sin
  // fichero no hay huella, y fuera de git no hay commit.
  const sello = node.verified.fingerprint
    ? `huella ${node.verified.fingerprint}`
    : node.verified.commit
      ? `commit ${node.verified.commit}`
      : 'solo fecha (sin fichero ni git: `stale` no podra comprobarlo)';
  return { output: `${id} verificado: ${sello} (${node.verified.date}).` };
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

/**
 * `rename`: cambia el id de un nodo y arregla todo lo que apuntaba a el.
 *
 * Sin esto, renombrar una clase obliga a editar a mano cada hecho que la
 * referencia. En un producto vivo se renombra constantemente, asi que la
 * alternativa real no es "hacerlo a mano": es que el indice se pudra en cada
 * refactor, que es como muere una herramienta de este tipo.
 *
 * Los miembros van con el tipo: renombrar `Erp.Ui.DetallePage` sin arrastrar
 * `Erp.Ui.DetallePage.OnAppearing` dejaria huerfano al hijo, y eso es siempre
 * un error, no una eleccion.
 */
export function cmdRename(args, options) {
  const [from, to] = args;
  if (!from || !to) throw new Error('Uso: edgelore rename <id-actual> <id-nuevo>');
  if (from === to) return { output: 'El id de origen y el de destino son el mismo.', code: 2 };
  if (!isValidId(to)) throw new Error(`El id nuevo no es valido: "${to}"`);

  const root = requireStoreRoot();
  const index = loadIndex(root);

  // Los hijos siguen al padre; el propio nodo puede no tener ficha y existir
  // solo como destino de aristas, y renombrarlo sigue siendo correcto.
  const mapa = new Map([[from, to]]);
  const candidatos = new Set([...index.nodes.keys(), ...index.incoming.keys()]);
  for (const id of candidatos) {
    if (id.startsWith(`${from}.`)) mapa.set(id, to + id.slice(from.length));
  }

  if (!candidatos.has(from) && mapa.size === 1) {
    return { output: `"${from}" no aparece en el indice, ni con ficha propia ni referenciado.`, code: 1 };
  }

  const chocan = [...mapa.values()].filter((nuevo) => index.nodes.has(nuevo));
  if (chocan.length && !options.force) {
    return {
      output: `Ya existen hechos con esos ids: ${chocan.join(', ')}.\n`
        + 'Fusionar dos nodos es otra operacion: revisa a mano o usa --force para sobreescribir.',
      code: 1,
    };
  }

  const renombrados = [];
  const aristasActualizadas = [];

  for (const node of [...index.nodes.values()]) {
    const nuevoId = mapa.get(node.id) ?? node.id;
    const aristas = (node.edges ?? []).map((edge) => {
      const destino = mapa.get(edge.to);
      if (!destino) return edge;
      aristasActualizadas.push(`${nuevoId} -> ${destino}`);
      return { ...edge, to: destino };
    });

    const cambiaId = nuevoId !== node.id;
    const cambianAristas = aristas.some((edge, i) => edge.to !== node.edges[i].to);
    if (!cambiaId && !cambianAristas) continue;

    const notas = node.notes ?? '';
    const actualizado = { ...node, id: nuevoId, edges: aristas };
    delete actualizado.notes;
    delete actualizado._file;

    writeNode(root, actualizado, notas);
    if (cambiaId) {
      fs.rmSync(nodePath(root, node.id), { force: true });
      renombrados.push(`${node.id} -> ${nuevoId}`);
    }
  }

  const lines = [];
  if (renombrados.length) {
    lines.push(`Renombrados ${renombrados.length} hecho(s):`);
    renombrados.forEach((entry) => lines.push(`  ${entry}`));
  } else {
    lines.push(`"${from}" no tenia ficha propia; solo se han actualizado las referencias.`);
  }
  if (aristasActualizadas.length) {
    lines.push('', `${aristasActualizadas.length} arista(s) reapuntadas al id nuevo.`);
  }
  lines.push('', 'Comprueba que el fichero declarado sigue siendo correcto: edgelore validate');
  return { output: lines.join('\n') };
}
