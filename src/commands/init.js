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

const SKIP_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist', 'build', 'vendor', 'packages', '.vs']);
const PROJECT_FILES = /\.(csproj|fsproj|vbproj|sln|props|targets)$/i;
const MAX_SCAN_DEPTH = 3;
const MAX_SCAN_BYTES = 512 * 1024;

/**
 * Recoge los ficheros de proyecto del repositorio, con profundidad y tamano
 * acotados: detectar el stack no puede convertirse en recorrer un monorepo
 * entero durante el arranque.
 */
function collectProjectFiles(root) {
  const names = [];
  let contents = '';

  const walk = (dir, depth) => {
    if (depth > MAX_SCAN_DEPTH || contents.length > MAX_SCAN_BYTES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), depth + 1);
      } else if (PROJECT_FILES.test(entry.name)) {
        names.push(entry.name);
        try {
          contents += fs.readFileSync(path.join(dir, entry.name), 'utf8');
        } catch {
          /* un fichero ilegible no debe impedir la deteccion */
        }
      }
    }
  };

  walk(root, 0);
  return { names, contents };
}

/**
 * Deduce que reglas tienen sentido en este repositorio.
 *
 * Instalar las cuatro reglas de .NET en un proyecto de Python seria ruido que
 * alguien tendria que borrar a mano, y `edgelore init` debe poder ejecutarse a
 * secas, como `git init`. Solo se instala lo que se detecta; si no se reconoce
 * nada, no se instala ninguna y se explica como anadirlas.
 */
export function detectRuleSets(root) {
  const { names, contents } = collectProjectFiles(root);
  if (!names.length) return [];

  const detected = ['dotnet-core'];
  if (/<UseMaui>|Microsoft\.Maui|Xamarin\.Forms/i.test(contents)) detected.push('dotnet-maui');
  if (/EntityFrameworkCore|Microsoft\.Data\.SqlClient|System\.Data\.SqlClient|Dapper|npgsql/i.test(contents)) {
    detected.push('dotnet-data');
  }
  if (/Hosting\.WindowsServices|ServiceBase|WindowsService/i.test(contents)) detected.push('dotnet-winservice');

  const available = availableRuleSets();
  return detected.filter((name) => available.includes(name));
}

/**
 * `rules add`: instala conjuntos de reglas en un repositorio ya inicializado.
 *
 * Es la via segura para ampliar despues: a diferencia de `init --force`, jamas
 * sobreescribe una regla existente, que puede llevar semanas de ajustes del
 * equipo.
 */
export function cmdRules(args, options) {
  const action = args[0];
  const root = path.resolve(options.dir ?? findStoreRoot() ?? process.cwd());
  const available = availableRuleSets();

  if (action === 'list' || !action) {
    const installed = fs.existsSync(paths(root).rules)
      ? fs.readdirSync(paths(root).rules).filter((n) => /\.ya?ml$/.test(n)).map((n) => n.replace(/\.ya?ml$/, ''))
      : [];
    const lines = ['Reglas instaladas en este repositorio:'];
    installed.forEach((name) => lines.push(`  ${name}`));
    if (!installed.length) lines.push('  (ninguna)');
    const rest = available.filter((name) => !installed.includes(name));
    if (rest.length) {
      lines.push('', 'Disponibles para anadir:');
      rest.forEach((name) => lines.push(`  ${name}`));
      lines.push('', `  edgelore rules add ${rest[0]}`);
    }
    return { output: lines.join('\n') };
  }

  if (action !== 'add') {
    return { output: 'Uso: edgelore rules [list]\n     edgelore rules add <nombre...>', code: 2 };
  }

  const names = args.slice(1);
  if (!names.length) {
    return { output: `Uso: edgelore rules add <nombre...>\nDisponibles: ${available.join(', ')}`, code: 2 };
  }
  const unknown = names.filter((name) => !available.includes(name));
  if (unknown.length) {
    return { output: `Reglas desconocidas: ${unknown.join(', ')}\nDisponibles: ${available.join(', ')}`, code: 2 };
  }

  const report = { written: [], skipped: [] };
  for (const name of names) {
    copyIfAbsent(path.join(TEMPLATES, 'rules', `${name}.yaml`), path.join(paths(root).rules, `${name}.yaml`), report);
  }
  const lines = [];
  report.written.forEach((file) => lines.push(`  anadida  ${path.relative(root, file)}`));
  report.skipped.forEach((file) => lines.push(`  ya estaba ${path.relative(root, file)} (no se toca)`));
  lines.push('', 'Ejecuta `edgelore kinds` para ver los tipos de nodo que aportan.');
  return { output: lines.join('\n') };
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
  const explicit = options.rules?.length ? options.rules : null;
  const requested = explicit?.includes('all') ? available : explicit ?? detectRuleSets(root);
  const unknown = requested.filter((name) => !available.includes(name));
  if (unknown.length) {
    throw new Error(`Reglas desconocidas: ${unknown.join(', ')}\nDisponibles: ${available.join(', ')}`);
  }
  const detected = explicit === null;

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
  lines.push('');
  if (requested.length) {
    lines.push(
      detected
        ? `Reglas instaladas segun el stack detectado: ${requested.join(', ')}`
        : `Reglas instaladas: ${requested.join(', ')}`,
    );
  } else {
    lines.push(
      'No se ha reconocido el stack, asi que no se ha instalado ninguna regla.',
      'Edgelore funciona igual sin ellas: solo dejan de generarse solas las aristas',
      'de ciclo de vida. Para anadirlas:',
      `  edgelore rules add <nombre>     disponibles: ${available.join(', ')}`,
      '  o escribe las vuestras siguiendo docs/RULES.md',
    );
  }
  lines.push(
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
