#!/usr/bin/env node
/**
 * Punto de entrada del CLI de Edgelore.
 *
 * Sin dependencias externas, tambien para el parseo de argumentos: este binario
 * se ejecuta en cada hook de edicion, y el coste de arranque de un arbol de
 * dependencias se notaria en cada guardado.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdQuery, cmdImpact, cmdFind, cmdPath, cmdStats, cmdKinds, cmdChecklist, cmdValidate, cmdStale, cmdPrune } from '../src/commands/read.js';
import { cmdAdd, cmdLink, cmdVerify, cmdRemove, cmdRename } from '../src/commands/write.js';
import { cmdInit, cmdUninstall, cmdRules, availableRuleSets } from '../src/commands/init.js';
import { cmdHook } from '../src/commands/hook.js';
import { EDGE_TYPES, CONFIDENCE } from '../src/model.js';

const VERSION = '0.1.0';

/** Banderas que aceptan valor; el resto son booleanas. Repetibles marcadas aparte. */
const VALUE_FLAGS = new Set(['file', 'kind', 'summary', 'lang', 'note', 'trigger', 'at', 'confidence', 'dir', 'limit', 'depth', 'module', 'max-age']);
const LIST_FLAGS = new Set(['edge', 'tag', 'rules']);

export function parseArgs(argv) {
  const args = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      args.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    let value = eq === -1 ? undefined : body.slice(eq + 1);

    if (value === undefined && (VALUE_FLAGS.has(name) || LIST_FLAGS.has(name))) {
      value = argv[++i];
      if (value === undefined) throw new Error(`La opcion --${name} necesita un valor.`);
    }

    if (LIST_FLAGS.has(name)) {
      options[name] ??= [];
      // `--rules a,b` y `--rules a --rules b` son equivalentes.
      options[name].push(...String(value).split(',').map((part) => part.trim()).filter(Boolean));
    } else if (VALUE_FLAGS.has(name)) {
      options[name] = name === 'limit' || name === 'depth' || name === 'max-age' ? Number(value) : value;
    } else {
      options[name] = true;
    }
  }
  return { args, options };
}

const COMMANDS = {
  init: { run: cmdInit, help: 'Prepara el repositorio actual: .edgelore/, reglas, skill y hooks.' },
  rules: { run: cmdRules, help: 'Lista las reglas instaladas o anade mas: `rules add <nombre>`.' },
  uninstall: { run: cmdUninstall, help: 'Retira skill y hooks. Con --all borra tambien los hechos.' },
  add: { run: cmdAdd, help: 'Registra o actualiza un hecho.' },
  link: { run: cmdLink, help: 'Anade una arista entre dos nodos.' },
  query: { run: cmdQuery, help: 'Muestra un nodo con sus aristas salientes y entrantes.' },
  impact: { run: cmdImpact, help: 'Que depende de esto. --files da la lista de sitios que revisar.' },
  find: { run: cmdFind, help: 'Busca hechos por texto.' },
  path: { run: cmdPath, help: 'Camino mas corto conocido entre dos nodos.' },
  verify: { run: cmdVerify, help: 'Sella un hecho como comprobado con el contenido actual.' },
  rename: { run: cmdRename, help: 'Cambia el id de un nodo y reapunta todo lo que le referenciaba.' },
  remove: { run: cmdRemove, help: 'Elimina un hecho.' },
  validate: { run: cmdValidate, help: 'Comprueba la coherencia del indice. Pensado para CI.' },
  prune: { run: cmdPrune, help: 'Lista (o con --apply borra) los hechos cuyo fichero ya no existe.' },
  stale: { run: cmdStale, help: 'Lista los hechos cuyo codigo cambio despues de verificarlos.' },
  stats: { run: cmdStats, help: 'Cobertura del indice.' },
  kinds: { run: cmdKinds, help: 'Tipos de nodo declarados por las reglas activas.' },
  checklist: { run: cmdChecklist, help: 'Comprobaciones manuales asociadas a un kind.' },
  hook: { run: cmdHook, help: 'Uso interno: hook PostToolUse de Claude Code.' },
};

function help() {
  const commands = Object.entries(COMMANDS)
    .filter(([name]) => name !== 'hook')
    .map(([name, { help: text }]) => `  ${name.padEnd(10)} ${text}`)
    .join('\n');

  return `edgelore ${VERSION} - indice curado de referencias ocultas de un codebase

USO
  edgelore <comando> [argumentos] [opciones]

COMANDOS
${commands}

TIPOS DE ARISTA
${Object.entries(EDGE_TYPES).map(([key, text]) => `  ${key.padEnd(11)} ${text}`).join('\n')}

CONFIANZA
${Object.entries(CONFIDENCE).map(([key, text]) => `  ${key.padEnd(11)} ${text}`).join('\n')}

OPCIONES COMUNES
  --json          Salida en JSON para herramientas.
  --brief         Omite las notas largas en query.
  --strict        En validate, la desincronizacion con el codigo tambien rompe.
  --apply         En prune, borra de verdad. Sin el, solo lista.
  --unverified    Al escribir, no sella el hecho como verificado.
  --confidence X  certain, likely o unverified.
  --all           En query/impact, lista todas las dependencias sin recortar.
  --limit N       Cuantas listar por nivel antes de resumir (por defecto 12).
  --files         En impact, la lista de trabajo: ficheros concretos a revisar.
  --module P      Limita a los ids que empiecen por ese prefijo de modulo.
  --max-age N     Dias tras los que un hecho verificado se marca como no
                  reverificado (por defecto 365). En validate, ademas lista
                  los que lo superan; con --strict, rompe.

CONFIANZA POR DEFECTO
  edgelore link         certain      es una afirmacion deliberada sobre una relacion
  edgelore add --edge   unverified   se escriben de corrido; confirmalas despues
  reglas de kind    la que declare la regla (normalmente certain)

EJEMPLOS
  edgelore init                                    # detecta el stack solo
  edgelore add Erp.Ventas.PagoService --file src/Ventas/PagoService.cs --kind service
  edgelore link AppShell Erp.Ui.DetallePage string-ref --at AppShell.xaml.cs:42 \\
    --note 'registrada como ruta "detalle"'
  edgelore impact Erp.Ui.DetallePage.OnAppearing            # orientarse: cuanto alcanza
  edgelore impact Base.PageBase.OnAppearing --files --depth 1   # que ficheros revisar
  edgelore impact Base.PageBase.OnAppearing --files --module Erp.Ventas
  edgelore query Erp.Ui.DetallePage
  edgelore path AppShell Erp.Data.FacturaRepository

REGLAS DISPONIBLES EN init
  ${availableRuleSets().join(', ') || '(ninguna)'}
`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${help()}\n`);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const name = argv[0];
  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write(`Comando desconocido: ${name}\nEjecuta \`edgelore help\` para ver los disponibles.\n`);
    return 2;
  }

  const { args, options } = parseArgs(argv.slice(1));
  const result = await command.run(args, options);
  const output = result?.output ?? '';
  if (output) process.stdout.write(`${output}\n`);
  return result?.code ?? 0;
}

/**
 * true solo cuando este fichero se ejecuta como binario.
 *
 * La guarda existe porque los tests importan parseArgs desde aqui y, sin ella,
 * el proceso de pruebas terminaria al cargar el modulo. Pero comparar rutas a
 * secas no vale: npm instala el binario como un SYMLINK, de modo que argv[1] es
 * la ruta del enlace y import.meta.url la real. Sin resolver el enlace, la
 * comparacion falla siempre y el CLI instalado no ejecuta nada, saliendo con
 * codigo 0 en cada orden como si hubiera funcionado.
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return path.resolve(entry) === self;
  }
}

/**
 * Se fija exitCode en vez de llamar a process.exit().
 *
 * Cuando stdout es una tuberia -que es como lo consumen el hook y cualquier
 * agente- la escritura es asincrona, y process.exit() mata el proceso antes de
 * vaciar el bufer: la salida se cortaba a los 65.536 bytes, a mitad de linea y
 * sin ningun aviso. Dejando terminar el proceso por su cuenta, Node vacia
 * stdout antes de salir.
 */
if (isMainModule()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    });
}
