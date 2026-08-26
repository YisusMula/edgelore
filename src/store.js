/**
 * Acceso al almacen de hechos: `.edgelore/` dentro del repositorio de trabajo.
 *
 * Un fichero por nodo, a proposito. Un unico fichero grande produciria un
 * conflicto de merge en practicamente cada pull request, y un indice que da
 * guerra al equipo deja de rellenarse a las dos semanas.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, parseYaml, stringifyFrontmatter } from './frontmatter.js';
import { idToFilename, normalizeNode, validateNode } from './model.js';

export const EDGELORE_DIR = '.edgelore';

export class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreError';
  }
}

/** Busca `.edgelore/` hacia arriba desde `start`, como hace git con `.git`. */
export function findStoreRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, EDGELORE_DIR, 'config.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireStoreRoot(start = process.cwd()) {
  const root = findStoreRoot(start);
  if (!root) {
    throw new StoreError(
      'No se ha encontrado ningun indice de Edgelore en este repositorio.\n' +
        'Ejecuta `edgelore init` en la raiz del repositorio para crearlo.',
    );
  }
  return root;
}

export function paths(root) {
  const base = path.join(root, EDGELORE_DIR);
  return {
    base,
    config: path.join(base, 'config.yaml'),
    nodes: path.join(base, 'nodes'),
    rules: path.join(base, 'rules'),
  };
}

/** El config se escribe como YAML plano, sin delimitadores de frontmatter. */
export function loadConfig(root) {
  const { config } = paths(root);
  if (!fs.existsSync(config)) return {};
  const text = fs.readFileSync(config, 'utf8');
  const data = text.trimStart().startsWith('---') ? parseFrontmatter(text).data : parseYaml(text);
  return data ?? {};
}

export function listNodeFiles(root) {
  const { nodes } = paths(root);
  if (!fs.existsSync(nodes)) return [];
  return fs
    .readdirSync(nodes)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => path.join(nodes, name));
}

export function readNodeFile(file) {
  const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  return { ...normalizeNode(data), notes: body, _file: file };
}

export function writeNode(root, node, notes = '') {
  const { nodes } = paths(root);
  fs.mkdirSync(nodes, { recursive: true });
  const normalized = normalizeNode(node);
  const problems = validateNode(normalized, { source: normalized.id ?? 'hecho' });
  if (problems.length) throw new StoreError(problems.join('\n'));
  const file = path.join(nodes, idToFilename(normalized.id));
  fs.writeFileSync(file, stringifyFrontmatter(normalized, notes), 'utf8');
  return file;
}

export function nodePath(root, id) {
  return path.join(paths(root).nodes, idToFilename(id));
}

export function readNode(root, id) {
  const file = nodePath(root, id);
  if (!fs.existsSync(file)) return null;
  const node = readNodeFile(file);
  // Defensa en profundidad: si el fichero no declara el id que se pedia, no es
  // el hecho buscado. Devolver null hace que se cree el correcto en vez de
  // editar por error el de otro nodo.
  return node.id === id ? node : null;
}

/**
 * Carga todos los hechos y construye el indice en memoria, incluidas las
 * aristas entrantes derivadas. Con miles de ficheros pequenos esto tarda
 * milisegundos, asi que no hay ninguna cache que pueda quedarse obsoleta.
 */
/** Version de formato que entiende esta build del CLI. */
export const FORMAT_VERSION = 1;

export function loadIndex(root) {
  const nodes = new Map();
  const incoming = new Map();
  const problems = [];

  // Un companero con una version antigua leyendo un indice escrito por una mas
  // nueva podria interpretar mal los hechos en silencio. Mejor decirlo.
  const declared = Number(loadConfig(root).version ?? FORMAT_VERSION);
  if (Number.isFinite(declared) && declared > FORMAT_VERSION) {
    problems.push(
      `el indice declara la version de formato ${declared} y este CLI entiende hasta la ${FORMAT_VERSION}; actualiza edgelore`,
    );
  }

  for (const file of listNodeFiles(root)) {
    let node;
    try {
      node = readNodeFile(file);
    } catch (error) {
      problems.push(`${path.basename(file)}: ${error.message}`);
      continue;
    }
    const label = path.basename(file);
    problems.push(...validateNode(node, { source: label }));
    if (!node.id) continue;
    if (nodes.has(node.id)) {
      problems.push(`${label}: el id "${node.id}" ya esta definido en otro fichero`);
      continue;
    }
    nodes.set(node.id, node);
  }

  // Windows no distingue mayusculas en los nombres de fichero: dos ids que solo
  // difieran en el caso conviven en Linux y en CI, pero colapsan en el portatil
  // de quien desarrolla. Se avisa aqui para que `edgelore validate` lo detecte antes
  // de que alguien pierda un hecho sin enterarse.
  const byLowercase = new Map();
  for (const id of nodes.keys()) {
    const key = id.toLowerCase();
    if (byLowercase.has(key)) {
      problems.push(`"${id}" y "${byLowercase.get(key)}" solo se diferencian en mayusculas y colisionarian en Windows`);
    } else {
      byLowercase.set(key, id);
    }
  }

  for (const node of nodes.values()) {
    for (const edge of node.edges ?? []) {
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      incoming.get(edge.to).push({ ...edge, from: node.id });
    }
  }

  return { root, nodes, incoming, problems };
}

/** Aristas entrantes de un id, ordenadas de forma estable. */
export function incomingEdges(index, id) {
  return [...(index.incoming.get(id) ?? [])].sort(
    (a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type),
  );
}

/** Ids referenciados por alguna arista pero que aun no tienen fichero propio. */
export function danglingIds(index) {
  return [...index.incoming.keys()].filter((id) => !index.nodes.has(id)).sort();
}

/**
 * Separa los ids sin ficha en los que son NORMALES y los que son SOSPECHOSOS.
 *
 * Las reglas generan aristas hacia miembros -`Pagina.OnAppearing`, `.ctor`-
 * que casi nunca tendran ficha propia, y eso esta bien. Un resto de renombrado
 * hecho sin `edgelore rename`, en cambio, es podredumbre.
 *
 * Contarlos juntos hacia que la lista tuviera cientos de entradas normales, que
 * es exactamente como se esconde una entrada que si importa: nadie la mira.
 */
export function classifyDangling(index) {
  const esperados = [];
  const sospechosos = [];

  for (const id of danglingIds(index)) {
    const aristas = index.incoming.get(id) ?? [];
    const soloReglas = aristas.length > 0 && aristas.every((edge) => String(edge.source ?? '').startsWith('rule:'));
    const corte = id.lastIndexOf('.');
    const padre = corte > 0 ? id.slice(0, corte) : null;
    // Miembro generado por una regla cuyo tipo si esta registrado: es lo normal.
    if (soloReglas && padre && index.nodes.has(padre)) esperados.push(id);
    else sospechosos.push(id);
  }

  return { esperados, sospechosos };
}
