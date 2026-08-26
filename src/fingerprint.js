/**
 * Huella del contenido que describe un hecho.
 *
 * Sustituye al commit como MECANISMO para detectar que un hecho se ha quedado
 * atras. La pregunta que importa no es "en que commit se verifico" sino "ha
 * cambiado el codigo que este hecho describe desde que alguien lo miro", y el
 * commit era un proxy peor por dos motivos:
 *
 *   - Obligaba a git. `verificationStamp` devolvia undefined fuera de un
 *     repositorio git, asi que en SVN, Mercurial, Perforce o en un arbol
 *     exportado sin historia NINGUN hecho llevaba sello y `stale` no podia
 *     decir nada.
 *   - Se evapora al reescribir la historia. `filesChangedSince` devuelve null
 *     cuando git no reconoce el commit, y `cmdStale` interpreta ese null como
 *     "ante la duda, no marcar nada". En un equipo que hace squash al mergear,
 *     el commit del sello deja de existir en cuanto se mergea la rama que lo
 *     escribio: a partir de ahi los hechos verificados dejaban de comprobarse
 *     EN SILENCIO, y `stale` respondia "todos al dia" porque no podia
 *     preguntar, no porque lo estuvieran.
 *
 * git no desaparece: pasa a ser un adaptador que enriquece el sello con "y fue
 * este commit el que lo cambio", que sigue siendo util para ir a mirarlo.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Cuantos caracteres hexadecimales del sha256 se guardan.
 *
 * 16 son 64 bits: de sobra para detectar un cambio, que es todo lo que se le
 * pide. Aqui no hay adversario intentando colisionar un hash, hay un fichero
 * que cambia o no cambia. Guardar los 64 caracteres enteros solo haria mas
 * ruidosa cada linea del frontmatter y cada diff.
 */
const LONGITUD = 16;

export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{16}$/;

/**
 * Normaliza los finales de linea antes de resumir.
 *
 * Sin esto, el mismo fichero da huellas distintas segun quien lo tenga en
 * disco: con `core.autocrlf=true` -el valor por defecto de Git para Windows-
 * el arbol de trabajo se materializa con CRLF y el de Linux con LF. Un equipo
 * mixto veria TODOS los hechos como caducados al cambiar de maquina, que es la
 * forma mas rapida de que la senal se ignore. Tambien se descarta el BOM, que
 * las herramientas de .NET anaden y quitan sin que nadie lo pida.
 */
export function normalizeContent(buffer) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, '\n');
}

/** Huella de un texto ya normalizado. Expuesta para poder probarla sin disco. */
export function fingerprintOf(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, LONGITUD)}`;
}

/**
 * Huella del fichero que describe un hecho, o null si no se puede calcular
 * (el nodo no tiene fichero, o el fichero ya no existe). Nunca lanza: un hecho
 * que apunta a un fichero borrado es asunto de `validate` y `prune`, no un
 * motivo para que falle el comando que estabas ejecutando.
 */
export function fingerprintFile(root, file) {
  if (!file) return null;
  try {
    return fingerprintOf(normalizeContent(fs.readFileSync(path.join(root, file))));
  } catch {
    return null;
  }
}
