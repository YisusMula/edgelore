import { createHash } from 'node:crypto';

/**
 * Esquema de un hecho de Nexo y su validacion.
 *
 * Un hecho describe UN nodo (una clase, un metodo, una tabla, una clave de
 * configuracion) y las aristas que salen de el. Las aristas entrantes no se
 * escriben nunca: se derivan al consultar, para que registrar una relacion
 * exija tocar un unico fichero y el equipo no genere conflictos de merge.
 */

/**
 * Vocabulario de tipos de arista. Es deliberadamente corto: un vocabulario
 * amplio se usa de forma inconsistente entre personas y deja de ser consultable.
 * `affects` es la valvula de escape honesta para lo que no encaja en el resto.
 */
export const EDGE_TYPES = {
  calls: 'Llamada explicita, visible en el codigo.',
  implements: 'Implementa una interfaz o hereda de un tipo.',
  reads: 'Lee estado: tabla, fichero, cache, propiedad compartida.',
  writes: 'Escribe estado: tabla, fichero, cache, propiedad compartida.',
  'string-ref': 'Referencia por literal de texto: rutas, reflexion, DI por nombre. Invisible a grep del simbolo.',
  lifecycle: 'Lo invoca el runtime o el framework, sin llamada escrita en ninguna parte.',
  event: 'Publica o se suscribe a un evento o mensaje.',
  config: 'Depende de una clave de configuracion o de una variable de entorno.',
  schedules: 'Lo dispara un temporizador, un job o una tarea programada.',
  affects: 'Efecto observado que no encaja en las categorias anteriores.',
};

/**
 * Cuanto te puedes fiar de la arista. Que aparezca en el fichero es la mitad de
 * la informacion; la otra mitad es si alguien lo comprobo.
 */
export const CONFIDENCE = {
  certain: 'Verificado leyendo el codigo o ejecutandolo.',
  likely: 'Deducido con fundamento, sin comprobar del todo.',
  unverified: 'Sospecha registrada para no perderla. Comprobar antes de fiarse.',
};

/** Orden canonico de claves: garantiza diffs minimos y estables en git. */
const NODE_KEY_ORDER = ['id', 'kind', 'file', 'lang', 'summary', 'tags', 'edges', 'verified'];
const EDGE_KEY_ORDER = ['to', 'type', 'confidence', 'source', 'trigger', 'at', 'note'];

const ID_PATTERN = /^[A-Za-z_][\w.+-]*(?:\/[\w.+-]+)*$/;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Convierte un id de nodo en un nombre de fichero seguro en Windows y Linux.
 *
 * Sanear a secas no basta: `A/B` y `A_B` colapsarian en el mismo fichero y uno
 * pisaria al otro sin avisar. Cuando el saneado cambia algo se anade un sufijo
 * derivado del id completo, de modo que la correspondencia sigue siendo
 * inyectiva y ningun hecho puede sobreescribir a otro.
 */
export function idToFilename(id) {
  const safe = id.replace(/[^\w.+-]/g, '_');
  if (safe === id) return `${safe}.md`;
  return `${safe}-${createHash('sha1').update(id).digest('hex').slice(0, 8)}.md`;
}

export function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && ID_PATTERN.test(id);
}

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Normaliza una arista al orden canonico, aplicando los valores por defecto. */
export function normalizeEdge(edge) {
  const out = {};
  for (const key of EDGE_KEY_ORDER) {
    if (key === 'confidence') out.confidence = edge.confidence ?? 'unverified';
    else if (key === 'source') out.source = edge.source ?? 'human';
    else if (edge[key] !== undefined && edge[key] !== null && edge[key] !== '') out[key] = edge[key];
  }
  return out;
}

/** Normaliza un hecho completo: claves ordenadas, aristas ordenadas y sin duplicados. */
export function normalizeNode(node) {
  const edges = asArray(node.edges)
    .map(normalizeEdge)
    .sort((a, b) => a.to.localeCompare(b.to) || a.type.localeCompare(b.type));

  const deduped = [];
  for (const edge of edges) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.to === edge.to && previous.type === edge.type) {
      deduped[deduped.length - 1] = { ...previous, ...edge };
      continue;
    }
    deduped.push(edge);
  }

  const out = {};
  for (const key of NODE_KEY_ORDER) {
    if (key === 'edges') out.edges = deduped;
    else if (key === 'tags') {
      const tags = asArray(node.tags);
      if (tags.length) out.tags = [...new Set(tags)].sort();
    } else if (node[key] !== undefined && node[key] !== null && node[key] !== '') {
      out[key] = node[key];
    }
  }
  return out;
}

/**
 * Valida un hecho y devuelve la lista de problemas. Se devuelven todos de golpe
 * en vez de lanzar al primero: quien esta arreglando el indice quiere la lista
 * completa, no descubrirlos de uno en uno.
 */
export function validateNode(node, { source = 'hecho' } = {}) {
  const problems = [];
  const fail = (message) => problems.push(`${source}: ${message}`);

  if (!isValidId(node.id)) {
    fail(`id ausente o invalido ("${node.id ?? ''}"). Se esperaba algo como Erp.Ventas.PagoService`);
  }
  if (node.summary !== undefined && typeof node.summary !== 'string') {
    fail('summary debe ser texto');
  }
  if (node.summary && node.summary.length > 300) {
    fail('summary supera 300 caracteres; el detalle va en el cuerpo del fichero, no en el frontmatter');
  }
  if (node.file !== undefined && typeof node.file !== 'string') {
    fail('file debe ser una ruta relativa a la raiz del repositorio');
  }
  if (node.file && (node.file.startsWith('/') || node.file.includes('..'))) {
    fail(`file debe ser una ruta relativa dentro del repositorio ("${node.file}")`);
  }

  asArray(node.edges).forEach((edge, index) => {
    const label = `arista ${index + 1}`;
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
      fail(`${label}: se esperaba un mapa con al menos "to" y "type"`);
      return;
    }
    if (!isValidId(edge.to)) fail(`${label}: "to" ausente o invalido ("${edge.to ?? ''}")`);
    if (!edge.type) fail(`${label}: falta "type"`);
    else if (!EDGE_TYPES[edge.type]) {
      fail(`${label}: type "${edge.type}" desconocido. Validos: ${Object.keys(EDGE_TYPES).join(', ')}`);
    }
    if (edge.confidence && !CONFIDENCE[edge.confidence]) {
      fail(`${label}: confidence "${edge.confidence}" desconocida. Validas: ${Object.keys(CONFIDENCE).join(', ')}`);
    }
    if (edge.source && !/^(human|rule:[\w.-]+|extractor:[\w.-]+)$/.test(edge.source)) {
      fail(`${label}: source "${edge.source}" invalida. Usa human, rule:<id> o extractor:<id>`);
    }
    // Una arista implicita sin disparador es justo la que nadie sabra interpretar
    // dentro de seis meses, que es el caso que Nexo existe para resolver.
    if ((edge.type === 'lifecycle' || edge.type === 'schedules') && !edge.trigger) {
      fail(`${label}: las aristas ${edge.type} necesitan "trigger" explicando que las dispara`);
    }
    if (edge.type === 'string-ref' && !edge.note && !edge.at) {
      fail(`${label}: las aristas string-ref necesitan "at" o "note" indicando donde esta el literal`);
    }
  });

  if (node.verified !== undefined) {
    if (typeof node.verified !== 'object' || Array.isArray(node.verified) || node.verified === null) {
      fail('verified debe ser un mapa con commit y date');
    } else if (!node.verified.commit) {
      fail('verified necesita el commit en el que se comprobo el hecho');
    }
  }

  return problems;
}
