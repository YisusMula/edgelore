/**
 * `edgelore init`: prepara un repositorio para usar el indice.
 *
 * Instala tres cosas y ninguna mas: el almacen de hechos, las reglas del stack
 * elegido, y la integracion con Claude (skill + hook). Todo se escribe dentro
 * del repositorio y se versiona con git, de modo que el indice viaja con el
 * codigo y crece con el equipo, igual que las specs de OpenSpec.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDGELORE_DIR, findStoreRoot, paths } from '../store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.resolve(HERE, '..', '..', 'templates');

export function availableRuleSets() {
  const dir = path.join(TEMPLATES, 'rules');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).map((name) => name.replace(/\.ya?ml$/, ''));
}

function copyIfAbsent(source, target, report, { force = false } = {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && !force) {
    report.skipped.push(target);
    return false;
  }
  fs.copyFileSync(source, target);
  report.written.push(target);
  return true;
}

function writeIfAbsent(target, content, report, { force = false } = {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && !force) {
    report.skipped.push(target);
    return false;
  }
  fs.writeFileSync(target, content, 'utf8');
  report.written.push(target);
  return true;
}

const CONFIG_TEMPLATE = (rules) => `# Configuracion de Edgelore.
#
# El indice vive en .edgelore/ y se versiona con el repositorio: cada persona del
# equipo lo amplia durante su trabajo normal y todos consumen el resultado.
#
# Las reglas activas son, sencillamente, los ficheros que haya en .edgelore/rules/.
# No hay una lista que mantener aqui: anadir un fichero basta para activarlo.
# Instaladas por \`edgelore init\`: ${rules.join(', ') || '(ninguna)'}.

version: 1
`;

/**
 * Comandos de hook que se registran en .claude/settings.json.
 *
 * Invocacion directa y portable: sin redirecciones de shell POSIX, que no
 * funcionan en cmd.exe, y sin `|| true`, que convertiria un `edgelore` ausente
 * en un hook que no hace nada durante meses sin que nadie lo note. El comando
 * ya sale siempre con codigo 0, asi que no puede bloquear una edicion.
 */
const HOOKS = [
  { matcher: 'Edit|Write|MultiEdit', event: 'PreToolUse', command: 'edgelore hook pre-edit' },
  { matcher: 'Edit|Write|MultiEdit', event: 'PostToolUse', command: 'edgelore hook post-edit' },
];

export function cmdInit(args, options) {
  const root = path.resolve(options.dir ?? process.cwd());
  if (!fs.existsSync(root)) throw new Error(`El directorio no existe: ${root}`);

  const existing = findStoreRoot(root);
  if (existing === root && !options.force) {
    return {
      output: `Ya hay un indice de Edgelore en ${path.join(root, EDGELORE_DIR)}.\nUsa --force para reinstalar plantillas y reglas.`,
      code: 1,
    };
  }

  const available = availableRuleSets();
  const requested = options.rules?.length ? options.rules : available;
  const unknown = requested.filter((name) => !available.includes(name));
  if (unknown.length) {
    throw new Error(`Reglas desconocidas: ${unknown.join(', ')}\nDisponibles: ${available.join(', ')}`);
  }

  const report = { written: [], skipped: [] };
  const store = paths(root);
  const force = Boolean(options.force);

  writeIfAbsent(store.config, CONFIG_TEMPLATE(requested), report, { force });
  fs.mkdirSync(store.nodes, { recursive: true });
  writeIfAbsent(path.join(store.nodes, '.gitkeep'), '', report, { force });

  for (const name of requested) {
    copyIfAbsent(path.join(TEMPLATES, 'rules', `${name}.yaml`), path.join(store.rules, `${name}.yaml`), report, { force });
  }

  if (!options['no-claude']) {
    copyIfAbsent(
      path.join(TEMPLATES, 'claude', 'skills', 'edgelore', 'SKILL.md'),
      path.join(root, '.claude', 'skills', 'edgelore', 'SKILL.md'),
      report,
      { force },
    );
    installHook(root, report);
  }

  // No se toca .gitignore: todo lo que Edgelore escribe se versiona a
  // proposito, y no genera ningun artefacto derivado que ignorar.

  const lines = [`Edgelore instalado en ${root}`, ''];
  report.written.forEach((file) => lines.push(`  creado   ${path.relative(root, file)}`));
  report.skipped.forEach((file) => lines.push(`  existia  ${path.relative(root, file)}`));
  lines.push(
    '',
    `Reglas activas: ${requested.join(', ')}`,
    '',
    'Siguientes pasos:',
    '  1. edgelore kinds                 ver los tipos de nodo que conocen las reglas',
    '  2. edgelore add <id> --kind ...   registrar el primer hecho',
    '  3. commit de .edgelore/           para que el equipo lo comparta',
    '',
    'Empieza por lo que ya os ha hecho perder tiempo: las conexiones que nadie',
    'recuerda. No intentes cubrir el proyecto entero de golpe.',
  );
  return { output: lines.join('\n') };
}

/**
 * Borra directorios que se han quedado vacios, subiendo hasta `stop`.
 *
 * Git no rastrea directorios vacios, asi que un `git status` limpio no prueba
 * que no quede rastro en disco. Desinstalar tiene que dejar el arbol como
 * estaba, no solo como git lo ve.
 */
function pruneEmptyDirs(dir, stop) {
  let current = path.resolve(dir);
  const limit = path.resolve(stop);
  while (current.startsWith(limit) && current !== limit) {
    if (!fs.existsSync(current) || fs.readdirSync(current).length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Registra los hooks en .claude/settings.json preservando lo que ya hubiera.
 * Nunca sobreescribe la configuracion existente del equipo.
 */
function installHook(root, report) {
  const file = path.join(root, '.claude', 'settings.json');
  const settings = readSettings(file);
  if (settings === null) {
    report.skipped.push(`${file} (no es JSON valido; hooks no instalados)`);
    return;
  }

  settings.hooks ??= {};
  let changed = false;
  for (const { matcher, event, command } of HOOKS) {
    settings.hooks[event] ??= [];
    const already = settings.hooks[event].some((entry) =>
      (entry.hooks ?? []).some((hook) => hook.command === command),
    );
    if (already) continue;
    settings.hooks[event].push({ matcher, hooks: [{ type: 'command', command }] });
    changed = true;
  }

  if (!changed) {
    report.skipped.push(file);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  report.written.push(file);
}

/**
 * `uninstall`: revierte lo que init dejo fuera de .edgelore/.
 *
 * Existe porque la huella de la herramienta no cabe entera en un solo
 * directorio: los hooks viven en un fichero de configuracion compartido con el
 * resto del equipo, asi que borrar .edgelore/ a mano los dejaria apuntando a un
 * indice inexistente. Quitar algo debe ser tan facil como ponerlo.
 */
export function cmdUninstall(args, options) {
  const root = path.resolve(options.dir ?? findStoreRoot() ?? process.cwd());
  const removed = [];
  const kept = [];

  const skill = path.join(root, '.claude', 'skills', 'edgelore');
  if (fs.existsSync(skill)) {
    fs.rmSync(skill, { recursive: true, force: true });
    pruneEmptyDirs(path.dirname(skill), root);
    removed.push(path.relative(root, skill));
  }

  const file = path.join(root, '.claude', 'settings.json');
  const settings = readSettings(file);
  if (settings === null) {
    kept.push(`${path.relative(root, file)} (no es JSON valido; revisa los hooks a mano)`);
  } else if (settings.hooks) {
    let changed = false;
    for (const event of Object.keys(settings.hooks)) {
      const before = settings.hooks[event]?.length ?? 0;
      settings.hooks[event] = (settings.hooks[event] ?? [])
        .map((entry) => ({
          ...entry,
          hooks: (entry.hooks ?? []).filter(
            (hook) => !(typeof hook.command === 'string' && hook.command.includes('edgelore hook')),
          ),
        }))
        // Se descarta la entrada solo si se queda sin comandos: puede compartir
        // matcher con hooks de otra herramienta que no son nuestros.
        .filter((entry) => (entry.hooks ?? []).length > 0);
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
      if (before !== (settings.hooks[event]?.length ?? 0)) changed = true;
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    if (changed) {
      // Si el fichero se queda sin nada, se borra: lo habiamos creado nosotros y
      // dejar un `{}` huerfano no es desinstalar del todo.
      if (Object.keys(settings).length === 0) {
        fs.rmSync(file, { force: true });
        removed.push(path.relative(root, file));
        pruneEmptyDirs(path.dirname(file), root);
      } else {
        fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
        removed.push(`hooks de edgelore en ${path.relative(root, file)}`);
      }
    }
  }

  const store = path.join(root, EDGELORE_DIR);
  if (options.all && fs.existsSync(store)) {
    fs.rmSync(store, { recursive: true, force: true });
    removed.push(`${EDGELORE_DIR}/ y todos los hechos registrados`);
  } else if (fs.existsSync(store)) {
    kept.push(`${EDGELORE_DIR}/ (los hechos del equipo; borralo con --all si de verdad quieres perderlos)`);
  }

  const lines = removed.length ? ['Eliminado:'] : ['No habia nada que desinstalar.'];
  removed.forEach((item) => lines.push(`  ${item}`));
  if (kept.length) {
    lines.push('', 'Conservado:');
    kept.forEach((item) => lines.push(`  ${item}`));
  }
  return { output: lines.join('\n') };
}
