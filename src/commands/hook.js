/**
 * Hook para Claude Code (evento PostToolUse sobre Edit/Write/MultiEdit).
 *
 * Es la pieza que hace que el indice se rellene solo. La disciplina de equipo no
 * se sostiene con documentacion: se sostiene apareciendo en el momento exacto en
 * que alguien acaba de tocar el codigo, que es cuando el hallazgo esta fresco y
 * registrarlo cuesta casi nada.
 *
 * Dos reglas inviolables aqui:
 *   - Nunca falla la herramienta que lo dispara. Ante cualquier error, sale en
 *     silencio con codigo 0. Un indice roto no puede bloquear el trabajo.
 *   - Nunca imprime el indice entero. Solo lo que afecta al fichero tocado.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findStoreRoot, loadIndex } from '../store.js';
import { changedSince, isGitRepo } from '../git.js';

const MAX_SUGGESTIONS = 6;

function readStdin() {
  try {
    // Lectura sincrona del descriptor 0: el hook debe terminar antes de
    // devolver el control a la herramienta que lo disparo.
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Extrae las rutas tocadas del payload del hook, tolerando formatos distintos. */
export function extractPaths(payload) {
  const input = payload?.tool_input ?? {};
  const candidates = [input.file_path, input.path, input.notebook_path];
  if (Array.isArray(input.edits)) candidates.push(...input.edits.map((edit) => edit?.file_path));
  if (Array.isArray(input.file_paths)) candidates.push(...input.file_paths);
  return [...new Set(candidates.filter((value) => typeof value === 'string' && value))];
}

/**
 * Construye el aviso para un conjunto de ficheros tocados. Devuelve null cuando
 * no hay nada util que decir, que es el caso mayoritario y debe ser silencioso.
 */
export function buildNotice(root, index, files, { git = false } = {}) {
  const relatives = files.map((file) => path.relative(root, path.resolve(root, file)).split(path.sep).join('/'));
  const tracked = relatives.filter((file) => !file.startsWith('..') && !file.startsWith('.edgelore/'));
  if (!tracked.length) return null;

  const known = [];
  for (const node of index.nodes.values()) {
    if (node.file && tracked.includes(node.file)) known.push(node);
  }

  const lines = [];

  if (known.length) {
    const suspect = known.filter(
      (node) => !node.verified?.commit || (git && changedSince(root, node.verified.commit, node.file)),
    );
    lines.push(`Edgelore: este fichero tiene ${known.length} hecho(s) registrados en el indice.`);
    known.slice(0, MAX_SUGGESTIONS).forEach((node) => {
      const edges = node.edges?.length ?? 0;
      lines.push(`  ${node.id} (${edges} arista${edges === 1 ? '' : 's'})`);
    });
    if (known.length > MAX_SUGGESTIONS) lines.push(`  ... y ${known.length - MAX_SUGGESTIONS} mas`);
    lines.push('');
    lines.push('Si el cambio altera alguna relacion, actualizala con `edgelore link`.');
    if (suspect.length) {
      lines.push(`Cuando confirmes que siguen siendo ciertos: ${suspect.map((n) => `edgelore verify ${n.id}`).join('  ')}`);
    }
  } else {
    // Sin ruido: solo se sugiere registrar cuando el indice ya esta en marcha,
    // para no molestar en un repositorio donde aun no se ha adoptado.
    if (index.nodes.size === 0) return null;
    lines.push(`Edgelore: ${tracked.join(', ')} no tiene ningun hecho registrado.`);
    lines.push('Si has descubierto alguna conexion no evidente (lifecycle, string-ref,');
    lines.push('evento, configuracion), registrala ahora que la tienes fresca:');
    lines.push(`  edgelore add <Id> --file ${tracked[0]} --kind <kind>`);
  }

  return lines.join('\n');
}

export function cmdHook(args) {
  const event = args[0] ?? 'post-edit';
  if (event !== 'post-edit') {
    return { output: `Evento de hook desconocido: ${event}`, code: 0 };
  }

  try {
    const raw = readStdin();
    if (!raw.trim()) return { output: '' };

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { output: '' };
    }

    const cwd = payload.cwd ?? process.cwd();
    const root = findStoreRoot(cwd);
    if (!root) return { output: '' };

    const files = extractPaths(payload);
    if (!files.length) return { output: '' };

    const index = loadIndex(root);
    const notice = buildNotice(root, index, files, { git: isGitRepo(root) });
    if (!notice) return { output: '' };

    // additionalContext hace que el aviso llegue al agente, no solo al log.
    return {
      output: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notice },
      }),
    };
  } catch {
    // Pase lo que pase, el hook no puede romper la edicion en curso.
    return { output: '' };
  }
}
