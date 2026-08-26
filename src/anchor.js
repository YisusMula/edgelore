/**
 * Anclas de contenido para las referencias `fichero:linea`.
 *
 * `at: src/AppShell.xaml.cs:42` deja de ser cierto en cuanto alguien anade una
 * linea mas arriba, y `at` es justo el campo de las aristas `string-ref`, que
 * son las de mas valor del indice: el dato mas valioso era el mas fragil, y
 * fallaba en silencio porque hasta ahora NADA comprobaba que la linea 42 fuera
 * la correcta. No es que se desincronizara; es que nunca se verifico.
 *
 * El ancla guarda el texto de esa linea. Al comprobar:
 *
 *   - la linea sigue casando          -> todo bien, no se toca nada
 *   - el ancla esta en OTRA linea     -> desplazamiento; `relocate` reescribe
 *   - el ancla no aparece             -> el hecho si esta caducado de verdad
 *
 * El efecto de segundo orden es el que importa: convierte el desplazamiento de
 * lineas (constante y sin significado) en cambio de contenido (raro y
 * significativo). Sin eso, cualquier aviso basado en `at` seria ruido continuo.
 *
 * NADA DE ESTO SE EJECUTA AL CONSULTAR. Abrir ficheros fuente en `query`,
 * `impact` o el hook cambiaria el modelo de coste de la herramienta -hoy una
 * consulta solo toca `.edgelore/`- y ralentizaria el camino que se recorre en
 * cada edicion. Se comprueba en `verify`, `relocate` y `validate`, que es
 * donde alguien esta mirando el estado del indice a proposito.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Un ancla mas larga que esto es una linea generada, no una referencia util. */
const MAX_ANCHOR = 120;

/** Separa `src/A.cs:42` en `{ file, line }`. null si no tiene esa forma. */
export function parseAt(at) {
  if (typeof at !== 'string') return null;
  const corte = at.lastIndexOf(':');
  if (corte <= 0) return null;
  const line = Number(at.slice(corte + 1));
  if (!Number.isInteger(line) || line <= 0) return null;
  const file = at.slice(0, corte);
  return file ? { file, line } : null;
}

/**
 * Normaliza para comparar: sin espacios al borde y con los interiores
 * colapsados. Reindentar un bloque es el cambio mas frecuente que NO altera lo
 * que la linea dice, y si contara como cambio el ancla seria inservible.
 */
export function normalizeAnchor(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Lineas del fichero, o null si no se puede leer. Nunca lanza.
 *
 * Acepta una cache opcional por invocacion. Varias aristas apuntan al mismo
 * fichero con frecuencia -diez rutas registradas en el mismo AppShell- y sin
 * cache se relee una vez por arista: medido con 30.000 anclas repartidas de
 * diez en diez, `validate` pasaba de 153 ms a 690 ms. La cache es por llamada y
 * no global: un proceso de larga vida que leyera de una cache global veria el
 * contenido de antes.
 */
function readLines(root, file, cache) {
  if (cache?.has(file)) return cache.get(file);
  let lines;
  try {
    lines = fs.readFileSync(path.join(root, file), 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  } catch {
    lines = null;
  }
  cache?.set(file, lines);
  return lines;
}

/** Texto de una linea (1-indexada) listo para guardar como ancla, o null. */
export function captureAnchor(root, at) {
  const parsed = parseAt(at);
  if (!parsed) return null;
  const lines = readLines(root, parsed.file);
  if (!lines) return null;
  const texto = normalizeAnchor(lines[parsed.line - 1]);
  // Una linea en blanco no ancla nada: la referencia se movio sola en cuanto
  // alguien toque el fichero, y guardarla daria una falsa sensacion de control.
  if (!texto) return null;
  return texto.length > MAX_ANCHOR ? texto.slice(0, MAX_ANCHOR) : texto;
}

/**
 * Estado de una arista con ancla. Devuelve uno de:
 *   { estado: 'sin-ancla' | 'sin-fichero' | 'ok' }
 *   { estado: 'movida', line }      el ancla esta en otra linea
 *   { estado: 'perdida' }           el ancla ya no aparece en el fichero
 */
export function checkAnchor(root, edge, cache) {
  if (!edge?.anchor || !edge?.at) return { estado: 'sin-ancla' };
  const parsed = parseAt(edge.at);
  if (!parsed) return { estado: 'sin-ancla' };
  const lines = readLines(root, parsed.file, cache);
  if (!lines) return { estado: 'sin-fichero' };

  const buscada = normalizeAnchor(edge.anchor);
  if (normalizeAnchor(lines[parsed.line - 1]) === buscada) return { estado: 'ok' };

  // Se busca desde la linea original hacia fuera: cuando hay varias lineas
  // iguales -algo muy comun en codigo- la correcta casi siempre es la mas
  // cercana a donde estaba, no la primera del fichero.
  const candidatas = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (normalizeAnchor(lines[i]) === buscada) candidatas.push(i + 1);
  }
  if (!candidatas.length) return { estado: 'perdida' };
  candidatas.sort((a, b) => Math.abs(a - parsed.line) - Math.abs(b - parsed.line) || a - b);
  return { estado: 'movida', line: candidatas[0], ambigua: candidatas.length > 1 };
}

/** `src/A.cs:42` con la linea cambiada. */
export function withLine(at, line) {
  const parsed = parseAt(at);
  return parsed ? `${parsed.file}:${line}` : at;
}
