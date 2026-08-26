/**
 * Parser y serializador de un subconjunto estricto de YAML.
 *
 * Edgelore no depende de librerias externas a proposito: el CLI se ejecuta en cada
 * hook de edicion, y una cadena de dependencias seria coste de arranque y
 * superficie de supply chain. El formato de los hechos esta bajo nuestro
 * control, asi que basta con soportar el subconjunto que define docs/SPEC.md:
 *
 *   - mapas anidados por indentacion
 *   - listas de bloque (`- item`), incluidas listas de mapas
 *   - listas en linea (`[a, b]`)
 *   - escalares: cadenas (con o sin comillas), true/false, null
 *
 * Todo lo que quede fuera se rechaza con un error que apunta a la linea, en vez
 * de interpretarse a medias. Un indice que miente es peor que no tener indice.
 */

const INDENT = '  ';

class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message} (linea ${line})` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

/** Elimina un comentario `#` respetando el contenido entrecomillado. */
function stripComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

/** Cabecera de escalar de bloque: `clave: >-`, `clave: |`, `- clave: >`... */
const BLOCK_HEADER = /^(.*?):[ \t]*([|>])([-+]?)$/;

/**
 * Pliega las lineas de un escalar `>`: las lineas consecutivas se unen con un
 * espacio y las lineas en blanco se convierten en salto de linea.
 */
function foldLines(bodyLines) {
  const out = [];
  let buffer = [];
  for (const line of bodyLines) {
    if (line.trim() === '') {
      if (buffer.length) out.push(buffer.join(' '));
      buffer = [];
      out.push('');
    } else {
      buffer.push(line.trim());
    }
  }
  if (buffer.length) out.push(buffer.join(' '));
  return out.join('\n');
}

/**
 * Convierte el texto en tokens por linea.
 *
 * Los escalares de bloque (`>-`, `|`) se resuelven aqui y no en el parser, para
 * poder leer su cuerpo en crudo: dentro de un bloque, una almohadilla es texto y
 * una linea en blanco significa algo. Los hechos de Edgelore estan llenos de prosa
 * explicativa, asi que perder fidelidad ahi seria perder justo lo que importa.
 */
function tokenize(src) {
  const raws = src.split(/\r?\n/);
  const lines = [];

  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];
    if (raw.includes('\t')) {
      throw new YamlError('se han encontrado tabulaciones; usa espacios', i + 1);
    }
    const text = stripComment(raw).trimEnd();
    if (!text.trim()) continue;
    const indent = text.length - text.trimStart().length;
    const trimmed = text.trim();

    const header = BLOCK_HEADER.exec(trimmed);
    if (!header) {
      lines.push({ indent, text: trimmed, line: i + 1 });
      continue;
    }

    const [, key, style, chomp] = header;
    const body = [];
    let blockIndent = null;
    let j = i + 1;
    while (j < raws.length) {
      const bodyRaw = raws[j];
      if (bodyRaw.trim() === '') {
        body.push('');
        j += 1;
        continue;
      }
      const bodyIndent = bodyRaw.length - bodyRaw.trimStart().length;
      if (bodyIndent <= indent) break;
      if (blockIndent === null) blockIndent = bodyIndent;
      body.push(bodyRaw.slice(blockIndent));
      j += 1;
    }
    while (body.length && body[body.length - 1].trim() === '') body.pop();

    let value = style === '|' ? body.join('\n') : foldLines(body);
    if (chomp !== '-' && value !== '') value += '\n';

    lines.push({ indent, text: `${key.trim()}:`, line: i + 1, blockValue: value });
    i = j - 1;
  }

  return lines;
}

function unquote(value, line) {
  const quote = value[0];
  if (value.length < 2 || value[value.length - 1] !== quote) {
    throw new YamlError('cadena entrecomillada sin cerrar', line);
  }
  const body = value.slice(1, -1);
  if (quote === "'") return body.replace(/''/g, "'");
  return body.replace(/\\(["\\nt])/g, (_, ch) => ({ '"': '"', '\\': '\\', n: '\n', t: '\t' }[ch]));
}

/**
 * Los escalares se dejan como cadena salvo los tres literales reservados. No se
 * convierten numeros a proposito: `2026-08-19` o `1.10` mutarian de tipo y los
 * campos de Edgelore (fechas, hashes, versiones) son textuales.
 */
function parseScalar(value, line) {
  const text = value.trim();
  if (text === '') return null;
  if (text[0] === '"' || text[0] === "'") return unquote(text, line);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (text[0] === '[') {
    if (text[text.length - 1] !== ']') throw new YamlError('lista en linea sin cerrar', line);
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitInline(inner, line).map((item) => parseScalar(item, line));
  }
  if (text[0] === '{') throw new YamlError('los mapas en linea no estan soportados; usa un bloque', line);
  return text;
}

/** Separa por comas de primer nivel, respetando comillas. */
function splitInline(text, line) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') current += text[++i] ?? '';
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (quote) throw new YamlError('cadena entrecomillada sin cerrar', line);
  parts.push(current.trim());
  return parts.filter((part) => part !== '');
}

/** Divide `clave: resto` respetando comillas en la clave. */
function splitKey(text, line) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      const rawKey = text.slice(0, i).trim();
      const key = rawKey[0] === '"' || rawKey[0] === "'" ? unquote(rawKey, line) : rawKey;
      if (!key) throw new YamlError('clave vacia', line);
      return [key, text.slice(i + 1).trim()];
    }
  }
  return null;
}

function parseBlock(lines, start, indent) {
  if (start >= lines.length) return [null, start];
  return lines[start].text.startsWith('- ') || lines[start].text === '-'
    ? parseList(lines, start, indent)
    : parseMap(lines, start, indent);
}

function parseList(lines, start, indent) {
  const items = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const { text, line } = lines[i];
    if (!text.startsWith('- ') && text !== '-') break;
    const rest = text === '-' ? '' : text.slice(2).trim();
    const childIndent = indent + 2;

    if (!rest) {
      // `-` a solas: el valor vive en el bloque indentado que sigue.
      const [value, next] = parseBlock(lines, i + 1, childIndent);
      items.push(value);
      i = next;
      continue;
    }

    const pair = splitKey(rest, line);
    if (!pair) {
      items.push(parseScalar(rest, line));
      i += 1;
      continue;
    }

    // Item que es un mapa: se reinyecta la primera clave como si estuviese
    // indentada, para que parseMap la vea junto al resto de sus hermanas.
    const virtual = [{ indent: childIndent, text: rest, line, blockValue: lines[i].blockValue }];
    let j = i + 1;
    while (j < lines.length && lines[j].indent >= childIndent) {
      virtual.push(lines[j]);
      j += 1;
    }
    const [value, consumed] = parseMap(virtual, 0, childIndent);
    if (consumed !== virtual.length) {
      throw new YamlError('indentacion inconsistente dentro del item de lista', virtual[consumed].line);
    }
    items.push(value);
    i = j;
  }
  return [items, i];
}

function parseMap(lines, start, indent) {
  const map = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const { text, line } = lines[i];
    if (text.startsWith('- ')) break;
    const pair = splitKey(text, line);
    if (!pair) throw new YamlError(`se esperaba "clave: valor" y se encontro "${text}"`, line);
    const [key, rest] = pair;
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw new YamlError(`clave duplicada "${key}"`, line);
    }

    // El escalar de bloque ya viene resuelto desde el tokenizador.
    if (lines[i].blockValue !== undefined) {
      map[key] = lines[i].blockValue;
      i += 1;
      continue;
    }

    if (rest) {
      map[key] = parseScalar(rest, line);
      i += 1;
      continue;
    }

    // Valor en bloque: puede ser un mapa mas indentado o una lista al mismo
    // nivel de la clave, que es como YAML permite escribir listas.
    const next = lines[i + 1];
    if (next && next.indent > indent) {
      const [value, consumed] = parseBlock(lines, i + 1, next.indent);
      map[key] = value;
      i = consumed;
    } else if (next && next.indent === indent && next.text.startsWith('- ')) {
      const [value, consumed] = parseList(lines, i + 1, indent);
      map[key] = value;
      i = consumed;
    } else {
      map[key] = null;
      i += 1;
    }
  }
  return [map, i];
}

export function parseYaml(src) {
  const lines = tokenize(src);
  if (lines.length === 0) return {};
  const baseIndent = lines[0].indent;
  const [value, consumed] = parseBlock(lines, 0, baseIndent);
  if (consumed !== lines.length) {
    throw new YamlError('indentacion inconsistente', lines[consumed].line);
  }
  return value;
}

const NEEDS_QUOTES = /^(\s|$)|[:#[\]{}",']|\s$|^(true|false|null|~|-)$/;

function formatScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value);
  if (text.includes('\n')) return JSON.stringify(text);
  return NEEDS_QUOTES.test(text) ? JSON.stringify(text) : text;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serializa preservando el orden de insercion de las claves. Edgelore escribe
 * siempre las claves en el mismo orden (ver model.js), de modo que dos personas
 * que editan el mismo hecho producen diffs minimos en vez de reordenaciones.
 */
export function stringifyYaml(value, depth = 0) {
  const pad = INDENT.repeat(depth);
  const lines = [];

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    for (const item of value) {
      if (isPlainObject(item) || Array.isArray(item)) {
        const body = stringifyYaml(item, depth + 1);
        const [first, ...rest] = body.replace(/\n$/, '').split('\n');
        lines.push(`${pad}- ${first.trimStart()}`);
        rest.forEach((entry) => lines.push(entry));
      } else {
        lines.push(`${pad}- ${formatScalar(item)}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      if (Array.isArray(entry) && entry.length > 0) {
        lines.push(`${pad}${key}:`);
        lines.push(stringifyYaml(entry, depth + 1).replace(/\n$/, ''));
      } else if (isPlainObject(entry) && Object.keys(entry).length > 0) {
        lines.push(`${pad}${key}:`);
        lines.push(stringifyYaml(entry, depth + 1).replace(/\n$/, ''));
      } else if (Array.isArray(entry)) {
        lines.push(`${pad}${key}: []`);
      } else if (isPlainObject(entry)) {
        lines.push(`${pad}${key}: {}`);
      } else {
        lines.push(`${pad}${key}: ${formatScalar(entry)}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  return `${pad}${formatScalar(value)}\n`;
}

/** Separa el frontmatter YAML del cuerpo Markdown de un fichero de hecho. */
export function parseFrontmatter(src) {
  const text = src.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(text.trim());
  if (!match) {
    throw new YamlError('el fichero no tiene frontmatter delimitado por "---"');
  }
  return { data: parseYaml(match[1]) ?? {}, body: (match[2] ?? '').trim() };
}

export function stringifyFrontmatter(data, body) {
  const notes = (body ?? '').trim();
  return `---\n${stringifyYaml(data).replace(/\n$/, '')}\n---\n${notes ? `\n${notes}\n` : ''}`;
}

export { YamlError };
