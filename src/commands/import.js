/**
 * `edgelore import <adaptador> <fichero>`.
 *
 * Buena parte del cableado oculto de un sistema YA esta declarado, estructurado
 * y fuera del codigo: tareas programadas, temporizadores, manifiestos. Pedirle a
 * una persona que lo transcriba al indice a mano es pedirle que copie datos que
 * una maquina puede leer, y eso no lo hace nadie dos veces.
 *
 * Es preferible a un extractor atado a un lenguaje: mas general, mucho mas
 * barato, sin dependencia de compilacion, y ataca los tipos de nodo donde una
 * persona aporta menos -nadie "descubre" a que hora corre un cron, esta escrito-.
 *
 * IDEMPOTENTE, y esa es la parte que hay que cuidar: reimportar conserva lo que
 * haya escrito una persona sobre ese nodo (notas, sello, otras aristas) y solo
 * reemplaza las aristas cuyo `source` es de este mismo adaptador. Un importador
 * que pisa el trabajo humano se ejecuta una vez y no se vuelve a tocar.
 */

import fs from 'node:fs';
import path from 'node:path';
import { requireStoreRoot, readNode, writeNode } from '../store.js';
import { validateNode, normalizeEdge } from '../model.js';
import { parseCrontab } from '../import/cron.js';
import { parseTimer } from '../import/systemd.js';

const ADAPTADORES = {
  cron: {
    help: 'crontab (de usuario o de sistema)',
    parse: (text) => parseCrontab(text),
  },
  systemd: {
    help: 'temporizador .timer de systemd',
    parse: (text, file) => parseTimer(text, path.basename(file).replace(/\.timer$/, '')),
  },
};

export function adapterNames() {
  return Object.keys(ADAPTADORES);
}

export function cmdImport(args, options) {
  const [nombre, fichero] = args;
  if (!nombre || !fichero) {
    const lista = Object.entries(ADAPTADORES).map(([id, a]) => `  ${id.padEnd(10)} ${a.help}`).join('\n');
    throw new Error(`Uso: edgelore import <adaptador> <fichero>\n\nAdaptadores:\n${lista}`);
  }
  const adaptador = ADAPTADORES[nombre];
  if (!adaptador) {
    return { output: `Adaptador desconocido: "${nombre}". Disponibles: ${adapterNames().join(', ')}`, code: 1 };
  }

  const root = requireStoreRoot();
  let text;
  try {
    text = fs.readFileSync(path.resolve(fichero), 'utf8');
  } catch (error) {
    return { output: `No se ha podido leer ${fichero}: ${error.message}`, code: 1 };
  }

  const { nodes, problemas } = adaptador.parse(text, fichero);
  const source = `import:${nombre}`;

  const escritos = [];
  const fusionados = [];
  const errores = [...problemas];

  for (const propuesto of nodes) {
    const existing = readNode(root, propuesto.id);
    let node;
    let notes = '';

    if (existing) {
      notes = existing.notes ?? '';
      node = { ...existing };
      delete node.notes;
      delete node._file;
      // Se conserva TODO lo humano y se reemplazan solo las aristas de este
      // adaptador: reimportar tras cambiar el horario actualiza el hecho sin
      // borrar la arista que alguien anadio a mano hacia el servicio real.
      const ajenas = (node.edges ?? []).filter((edge) => edge.source !== source);
      node.edges = [...ajenas, ...propuesto.edges].map(normalizeEdge);
      node.kind ??= propuesto.kind;
      node.summary = propuesto.summary;
      fusionados.push(propuesto.id);
    } else {
      node = { ...propuesto, edges: propuesto.edges.map(normalizeEdge) };
      escritos.push(propuesto.id);
    }

    const fallos = validateNode(node, { source: propuesto.id });
    if (fallos.length) {
      errores.push(...fallos);
      continue;
    }
    writeNode(root, node, notes);
  }

  if (options.json) return { output: JSON.stringify({ escritos, fusionados, errores }, null, 2) };

  const lines = [];
  if (escritos.length) {
    lines.push(`${escritos.length} hecho(s) nuevos desde ${nombre}:`);
    escritos.slice(0, 15).forEach((id) => lines.push(`  ${id}`));
    if (escritos.length > 15) lines.push(`  ... y ${escritos.length - 15} mas`);
  }
  if (fusionados.length) {
    if (lines.length) lines.push('');
    lines.push(`${fusionados.length} actualizado(s) (se conserva lo escrito a mano):`);
    fusionados.slice(0, 15).forEach((id) => lines.push(`  ${id}`));
    if (fusionados.length > 15) lines.push(`  ... y ${fusionados.length - 15} mas`);
  }
  if (errores.length) {
    if (lines.length) lines.push('');
    lines.push(`${errores.length} linea(s) sin importar:`);
    errores.slice(0, 10).forEach((problema) => lines.push(`  ${problema}`));
  }
  if (!lines.length) return { output: `${fichero} no contiene ninguna tarea que importar.` };

  lines.push('');
  lines.push('El destino de cada arista se ha deducido del comando y queda SIN VERIFICAR:');
  lines.push('comprueba que apunta al id real de tu codigo y corrigelo con `edgelore link`');
  lines.push('o `edgelore rename` si no cuadra.');
  return { output: lines.join('\n'), code: errores.length ? 1 : 0 };
}
