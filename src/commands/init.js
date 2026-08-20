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

const GITIGNORE_BLOCK = `
# Edgelore: los hechos SI se versionan; los artefactos derivados no.
.edgelore/cache/
`;

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
    installHook(root, report, { force });
  }

  const gitignore = path.join(root, '.gitignore');
  if (fs.existsSync(gitignore)) {
    const current = fs.readFileSync(gitignore, 'utf8');
    if (!current.includes('.edgelore/cache/')) {
      fs.appendFileSync(gitignore, GITIGNORE_BLOCK, 'utf8');
      report.written.push(gitignore);
    }
  } else {
    writeIfAbsent(gitignore, GITIGNORE_BLOCK.trimStart(), report, { force });
  }

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
 * Registra el hook PostToolUse en .claude/settings.json preservando lo que ya
 * hubiera. Nunca sobreescribe la configuracion existente del equipo.
 */
function installHook(root, report, { force }) {
  const file = path.join(root, '.claude', 'settings.json');
  // Invocacion directa y portable: sin redirecciones de shell POSIX, que no
  // funcionan en cmd.exe, y sin `|| true`, que convertiria un `edgelore` ausente en
  // un hook que no hace nada durante meses sin que nadie lo note. El propio
  // comando ya sale siempre con codigo 0, asi que no puede bloquear una edicion.
  const hookCommand = 'edgelore hook post-edit';

  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      report.skipped.push(`${file} (no es JSON valido; hook no instalado)`);
      return;
    }
  }

  settings.hooks ??= {};
  settings.hooks.PostToolUse ??= [];
  const already = settings.hooks.PostToolUse.some((entry) =>
    (entry.hooks ?? []).some((hook) => typeof hook.command === 'string' && hook.command.includes('edgelore hook')),
  );
  if (already && !force) {
    report.skipped.push(file);
    return;
  }
  if (!already) {
    settings.hooks.PostToolUse.push({
      matcher: 'Edit|Write|MultiEdit',
      hooks: [{ type: 'command', command: hookCommand }],
    });
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  report.written.push(file);
}
