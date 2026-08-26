/**
 * Reglas de framework.
 *
 * Las aristas implicitas -un `OnAppearing` que nadie llama, un servicio que el
 * SCM arranca solo, un controlador que instancia el contenedor de DI- no se
 * pueden inferir del codigo sin conocer el framework. Pero tampoco hace falta
 * descubrirlas una y otra vez: son convenciones estables que se declaran UNA vez
 * y se aplican a las cuarenta paginas del proyecto.
 *
 * Una regla aporta dos cosas:
 *   1. `implicit_edges`: aristas que se generan solas al declarar el `kind`.
 *   2. `checklist`: lo que una persona o un agente debe comprobar a mano,
 *      porque depende del caso concreto y ninguna regla puede adivinarlo.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './frontmatter.js';
import { paths } from './store.js';
import { normalizeEdge } from './model.js';

export function loadRules(root) {
  const dir = paths(root).rules;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      try {
        const data = parseYaml(fs.readFileSync(file, 'utf8')) ?? {};
        return { ...data, id: data.id ?? path.basename(name).replace(/\.ya?ml$/, ''), _file: file };
      } catch (error) {
        throw new Error(`No se ha podido leer la regla ${name}: ${error.message}`);
      }
    });
}

/** Indexa todos los `kind` declarados por todas las reglas cargadas. */
export function kindCatalog(rules) {
  const catalog = new Map();
  for (const rule of rules) {
    for (const [kind, definition] of Object.entries(rule.kinds ?? {})) {
      catalog.set(kind, { ...definition, kind, ruleId: rule.id, ruleName: rule.name ?? rule.id });
    }
  }
  return catalog;
}

/**
 * Genera las aristas implicitas de un nodo a partir de su `kind`.
 *
 * `member` produce un hijo (`Pagina.OnAppearing`) porque es lo que permite luego
 * preguntar "quien ejecuta OnAppearing" y obtener respuesta. `to` produce una
 * arista hacia un nodo externo ya existente.
 */
export function implicitEdgesFor(catalog, nodeId, kind) {
  const definition = catalog.get(kind);
  if (!definition) return [];
  return (definition.implicit_edges ?? []).map((template) => {
    const target = template.member ? `${nodeId}.${template.member}` : template.to;
    return normalizeEdge({
      to: target,
      type: template.type ?? 'lifecycle',
      confidence: template.confidence ?? 'certain',
      source: `rule:${definition.ruleId}`,
      trigger: template.trigger,
      note: template.note,
    });
  });
}

export function checklistFor(catalog, kind) {
  const definition = catalog.get(kind);
  if (!definition) return null;
  return {
    kind,
    label: definition.label ?? kind,
    ruleName: definition.ruleName,
    items: definition.checklist ?? [],
  };
}

export function renderKinds(catalog) {
  if (catalog.size === 0) {
    return 'No hay reglas cargadas. Anade ficheros a .edgelore/rules/ o ejecuta `edgelore init` de nuevo.';
  }
  const grouped = new Map();
  for (const definition of catalog.values()) {
    if (!grouped.has(definition.ruleName)) grouped.set(definition.ruleName, []);
    grouped.get(definition.ruleName).push(definition);
  }
  const lines = [];
  for (const [ruleName, definitions] of [...grouped].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${ruleName}:`);
    definitions
      .sort((a, b) => a.kind.localeCompare(b.kind))
      .forEach((definition) => {
        const count = (definition.implicit_edges ?? []).length;
        lines.push(`  ${definition.kind.padEnd(22)} ${definition.label ?? ''}${count ? `  (+${count} aristas)` : ''}`);
      });
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function renderChecklist(checklist) {
  if (!checklist) return null;
  const lines = [`Comprobaciones para ${checklist.label} (${checklist.ruleName}):`];
  if (!checklist.items.length) lines.push('  (esta regla no define comprobaciones manuales)');
  checklist.items.forEach((item) => lines.push(`  [ ] ${item}`));
  return lines.join('\n');
}
