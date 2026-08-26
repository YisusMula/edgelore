import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadIndex, writeNode, readNode, findStoreRoot, incomingEdges, danglingIds, classifyDangling } from '../src/store.js';
import { neighbourhood, renderNeighbourhood, search, path as findPath, stats, isHiddenEdge, impact, renderImpact, moduleOf, workList, renderWorkList, didYouMean, suggest, clamp, ageInDays, formatAge, decayLabel } from '../src/query.js';
import { normalizeNode, validateNode, idToFilename } from '../src/model.js';
import { fingerprintOf, normalizeContent, fingerprintFile } from '../src/fingerprint.js';
import { parseAt, normalizeAnchor, captureAnchor, checkAnchor } from '../src/anchor.js';
import { globMatcher } from '../src/glob.js';
import { deriveId } from '../src/scan.js';
import { parseCrontab, describeSchedule, jobName, looksLikeCron } from '../src/import/cron.js';
import { parseTimer, parseIni } from '../src/import/systemd.js';
import { cmdImport } from '../src/commands/import.js';
import { loadRules, kindCatalog, implicitEdgesFor } from '../src/rules.js';
import { buildNotice, buildImpactNotice, extractPaths } from '../src/commands/hook.js';
import { parseEdgeFlag, cmdAdd, cmdLink, cmdRename, cmdVerify } from '../src/commands/write.js';
import { cmdInit, cmdUninstall, cmdRules, detectRuleSets } from '../src/commands/init.js';
import { cmdValidate, cmdPrune, cmdStale, cmdRelocate, cmdSuggest, ordenarPorRotacion, sinInteresParaIndice, cmdScan } from '../src/commands/read.js';
import { parseArgs } from '../bin/edgelore.js';

/** Repositorio temporal con Edgelore instalado, para pruebas aisladas. */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edgelore-test-'));
  cmdInit([], { dir: root, rules: ['dotnet-maui', 'dotnet-core'], 'no-claude': true });
  return root;
}

test('init deja un almacen detectable desde subdirectorios', () => {
  const root = sandbox();
  const deep = path.join(root, 'src', 'Ui');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findStoreRoot(deep), root);
  assert.ok(fs.existsSync(path.join(root, '.edgelore', 'rules', 'dotnet-maui.yaml')));
});

test('init no pisa un indice existente salvo con --force', () => {
  const root = sandbox();
  const result = cmdInit([], { dir: root, 'no-claude': true });
  assert.equal(result.code, 1);
  assert.match(result.output, /Ya hay un indice/);
});

test('un hecho sobrevive al ciclo de escritura y lectura', () => {
  const root = sandbox();
  writeNode(root, {
    id: 'Erp.Ui.DetallePage',
    kind: 'maui-page',
    file: 'src/Ui/DetallePage.xaml.cs',
    edges: [{ to: 'Facturas', type: 'reads', confidence: 'certain' }],
  }, 'Carga en OnAppearing.');

  const node = readNode(root, 'Erp.Ui.DetallePage');
  assert.equal(node.kind, 'maui-page');
  assert.equal(node.edges[0].to, 'Facturas');
  assert.equal(node.notes, 'Carga en OnAppearing.');
});

test('las aristas entrantes se derivan sin escribirlas en ningun sitio', () => {
  const root = sandbox();
  writeNode(root, {
    id: 'AppShell',
    edges: [{ to: 'Erp.Ui.DetallePage', type: 'string-ref', at: 'AppShell.xaml.cs:42' }],
  });
  writeNode(root, { id: 'Erp.Ui.DetallePage', edges: [] });

  const index = loadIndex(root);
  const incoming = incomingEdges(index, 'Erp.Ui.DetallePage');
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].from, 'AppShell');
  // La ficha de DetallePage no menciona a AppShell: por eso registrar una
  // relacion solo toca un fichero y el equipo no genera conflictos de merge.
  assert.equal(readNode(root, 'Erp.Ui.DetallePage').edges.length, 0);
});

test('el kind genera las aristas implicitas del framework', () => {
  const root = sandbox();
  const catalog = kindCatalog(loadRules(root));
  const edges = implicitEdgesFor(catalog, 'Erp.Ui.DetallePage', 'maui-page');

  const onAppearing = edges.find((edge) => edge.to === 'Erp.Ui.DetallePage.OnAppearing');
  assert.ok(onAppearing, 'maui-page debe generar la arista de OnAppearing');
  assert.equal(onAppearing.type, 'lifecycle');
  assert.equal(onAppearing.source, 'rule:dotnet-maui');
  assert.match(onAppearing.trigger, /visible/);
});

test('un kind desconocido no genera aristas en vez de fallar', () => {
  const root = sandbox();
  const catalog = kindCatalog(loadRules(root));
  assert.deepEqual(implicitEdgesFor(catalog, 'X', 'kind-inexistente'), []);
});

test('normalizar ordena las aristas y fusiona duplicados', () => {
  const node = normalizeNode({
    id: 'A',
    edges: [
      { to: 'Z', type: 'calls' },
      { to: 'B', type: 'calls' },
      { to: 'B', type: 'calls', note: 'detalle posterior' },
    ],
  });
  assert.equal(node.edges.length, 2);
  assert.equal(node.edges[0].to, 'B');
  assert.equal(node.edges[0].note, 'detalle posterior');
});

test('la validacion exige trigger en las aristas implicitas', () => {
  const problems = validateNode({ id: 'A', edges: [{ to: 'B', type: 'lifecycle' }] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /trigger/);
});

test('la validacion exige localizar el literal de una string-ref', () => {
  assert.match(validateNode({ id: 'A', edges: [{ to: 'B', type: 'string-ref' }] })[0], /at.*note|note.*at/);
  assert.deepEqual(validateNode({ id: 'A', edges: [{ to: 'B', type: 'string-ref', at: 'x.cs:1' }] }), []);
});

test('la validacion rechaza tipos, confianzas y origenes inventados', () => {
  assert.match(validateNode({ id: 'A', edges: [{ to: 'B', type: 'inventado' }] })[0], /desconocido/);
  assert.match(validateNode({ id: 'A', edges: [{ to: 'B', type: 'calls', confidence: 'quiza' }] })[0], /confidence/);
  assert.match(validateNode({ id: 'A', edges: [{ to: 'B', type: 'calls', source: 'magia' }] })[0], /source/);
});

test('la validacion rechaza rutas que escapan del repositorio', () => {
  assert.match(validateNode({ id: 'A', file: '../../etc/passwd' })[0], /relativa/);
  assert.match(validateNode({ id: 'A', file: '/etc/passwd' })[0], /relativa/);
});

test('escribir un hecho invalido falla en vez de guardarlo', () => {
  const root = sandbox();
  assert.throws(() => writeNode(root, { id: 'A', edges: [{ to: 'B', type: 'lifecycle' }] }), /trigger/);
});

test('el indice detecta ids duplicados y ficheros ilegibles', () => {
  const root = sandbox();
  fs.writeFileSync(path.join(root, '.edgelore', 'nodes', 'roto.md'), 'esto no es frontmatter\n');
  const index = loadIndex(root);
  assert.ok(index.problems.some((problem) => problem.includes('roto.md')));
});

test('query devuelve el vecindario en ambos sentidos', () => {
  const root = sandbox();
  writeNode(root, { id: 'A', edges: [{ to: 'B', type: 'calls' }] });
  writeNode(root, { id: 'B', edges: [{ to: 'C', type: 'writes' }] });

  const result = neighbourhood(loadIndex(root), 'B');
  assert.equal(result.outgoing.length, 1);
  assert.equal(result.incoming.length, 1);
  assert.equal(result.incoming[0].from, 'A');
});

test('query resuelve nodos referenciados que aun no tienen ficha', () => {
  const root = sandbox();
  writeNode(root, { id: 'A', edges: [{ to: 'Fantasma', type: 'calls' }] });
  const index = loadIndex(root);

  const result = neighbourhood(index, 'Fantasma');
  assert.equal(result.node, null);
  assert.equal(result.incoming.length, 1);
  assert.deepEqual(danglingIds(index), ['Fantasma']);
});

test('path reconstruye una cadena que atraviesa aristas ocultas', () => {
  const root = sandbox();
  writeNode(root, { id: 'AppShell', edges: [{ to: 'Pagina', type: 'string-ref', at: 'x.cs:1' }] });
  writeNode(root, {
    id: 'Pagina',
    edges: [{ to: 'Pagina.OnAppearing', type: 'lifecycle', trigger: 'al hacerse visible' }],
  });
  writeNode(root, { id: 'Pagina.OnAppearing', edges: [{ to: 'Facturas', type: 'reads' }] });

  const steps = findPath(loadIndex(root), 'AppShell', 'Facturas');
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((step) => step.type), ['string-ref', 'lifecycle', 'reads']);
});

test('path recorre tambien en sentido inverso', () => {
  const root = sandbox();
  writeNode(root, { id: 'A', edges: [{ to: 'B', type: 'calls' }] });
  writeNode(root, { id: 'C', edges: [{ to: 'B', type: 'calls' }] });
  assert.ok(findPath(loadIndex(root), 'A', 'C'));
});

test('path devuelve null cuando no hay conexion conocida', () => {
  const root = sandbox();
  writeNode(root, { id: 'A', edges: [] });
  writeNode(root, { id: 'Z', edges: [] });
  assert.equal(findPath(loadIndex(root), 'A', 'Z'), null);
});

test('la busqueda prioriza coincidencias en el id sobre las notas', () => {
  const root = sandbox();
  writeNode(root, { id: 'Pago', edges: [] });
  writeNode(root, { id: 'Otro', edges: [] }, 'menciona Pago de pasada');
  const hits = search(loadIndex(root), 'pago');
  assert.equal(hits[0].id, 'Pago');
  assert.equal(hits.length, 2);
});

test('stats cuenta aparte las aristas que grep no encuentra', () => {
  const root = sandbox();
  writeNode(root, {
    id: 'A',
    edges: [
      { to: 'B', type: 'calls' },
      { to: 'C', type: 'lifecycle', trigger: 'el runtime' },
      { to: 'D', type: 'string-ref', at: 'x:1' },
    ],
  });
  const summary = stats(loadIndex(root));
  assert.equal(summary.edges, 3);
  assert.equal(summary.hidden, 2);
  assert.equal(isHiddenEdge({ type: 'calls' }), false);
});

test('parseEdgeFlag encamina la nota al campo correcto segun el tipo', () => {
  assert.equal(parseEdgeFlag('B:lifecycle:al arrancar').trigger, 'al arrancar');
  assert.equal(parseEdgeFlag('B:string-ref:ruta "x"').note, 'ruta "x"');
  assert.throws(() => parseEdgeFlag('B:inventado'), /desconocido/);
  assert.throws(() => parseEdgeFlag('solodestino'), /Formato/);
});

test('parseArgs entiende banderas con valor, repetibles y booleanas', () => {
  const { args, options } = parseArgs([
    'Erp.Page', '--file', 'src/a.cs', '--kind=maui-page',
    '--edge', 'B:calls', '--edge', 'C:reads', '--json',
  ]);
  assert.deepEqual(args, ['Erp.Page']);
  assert.equal(options.file, 'src/a.cs');
  assert.equal(options.kind, 'maui-page');
  assert.deepEqual(options.edge, ['B:calls', 'C:reads']);
  assert.equal(options.json, true);
});

test('parseArgs acepta listas separadas por comas', () => {
  assert.deepEqual(parseArgs(['--rules', 'a,b,c']).options.rules, ['a', 'b', 'c']);
});

test('parseArgs falla si una bandera con valor se queda sin el', () => {
  assert.throws(() => parseArgs(['--file']), /necesita un valor/);
});

test('el hook avisa de los hechos que cubren el fichero tocado', () => {
  const root = sandbox();
  writeNode(root, { id: 'A', file: 'src/a.cs', edges: [{ to: 'B', type: 'calls' }] });
  const notice = buildNotice(root, loadIndex(root), [path.join(root, 'src/a.cs')]);
  assert.match(notice, /1 hecho\(s\) registrados/);
  assert.match(notice, /\bA\b/);
});

test('el hook calla en un repositorio sin indice todavia', () => {
  const root = sandbox();
  assert.equal(buildNotice(root, loadIndex(root), [path.join(root, 'src/a.cs')]), null);
});

test('el hook ignora ediciones sobre el propio indice y fuera del repo', () => {
  const root = sandbox();
  writeNode(root, { id: 'A', file: 'src/a.cs', edges: [] });
  const index = loadIndex(root);
  assert.equal(buildNotice(root, index, [path.join(root, '.edgelore/nodes/A.md')]), null);
  assert.equal(buildNotice(root, index, ['/etc/passwd']), null);
});

test('extractPaths tolera las distintas formas del payload de Claude Code', () => {
  assert.deepEqual(extractPaths({ tool_input: { file_path: 'a.cs' } }), ['a.cs']);
  assert.deepEqual(extractPaths({ tool_input: { edits: [{ file_path: 'a.cs' }, { file_path: 'b.cs' }] } }), ['a.cs', 'b.cs']);
  assert.deepEqual(extractPaths({}), []);
  assert.deepEqual(extractPaths(null), []);
});

test('ids que solo difieren en caracteres no seguros no comparten fichero', () => {
  // Regresion: `A/B` y `A_B` colapsaban en A_B.md y uno pisaba al otro.
  const a = idToFilename('Erp/Ventas');
  const b = idToFilename('Erp_Ventas');
  assert.notEqual(a, b);
  assert.equal(idToFilename('Erp.Ventas.PagoService'), 'Erp.Ventas.PagoService.md');
  assert.equal(idToFilename('Erp/Ventas'), idToFilename('Erp/Ventas'), 'debe ser determinista');
});

test('dos hechos con ids saneables distintos conviven sin pisarse', () => {
  const root = sandbox();
  writeNode(root, { id: 'Erp/Ventas', edges: [] });
  writeNode(root, { id: 'Erp_Ventas', edges: [] });
  const index = loadIndex(root);
  assert.equal(index.nodes.size, 2);
  assert.ok(index.nodes.has('Erp/Ventas'));
  assert.ok(index.nodes.has('Erp_Ventas'));
});

test('readNode no devuelve un hecho cuyo id no coincide con el pedido', () => {
  const root = sandbox();
  writeNode(root, { id: 'Correcto', edges: [] });
  // Se falsea un fichero cuyo contenido declara otro id distinto del nombre.
  fs.writeFileSync(path.join(root, '.edgelore', 'nodes', 'Impostor.md'), '---\nid: Correcto\n---\n');
  assert.equal(readNode(root, 'Impostor'), null);
});

test('validate avisa de ids que colisionarian en Windows', () => {
  const root = sandbox();
  writeNode(root, { id: 'PagoService', edges: [] });
  writeNode(root, { id: 'pagoservice', edges: [] });
  const index = loadIndex(root);
  assert.ok(index.problems.some((problem) => /mayusculas/.test(problem)));
});

/** Los comandos resuelven el almacen desde process.cwd(), como haria el CLI. */
function inSandbox(fn) {
  const root = sandbox();
  const previous = process.cwd();
  process.chdir(root);
  try {
    return fn(root);
  } finally {
    process.chdir(previous);
  }
}

test('las aristas de --edge nacen sin verificar salvo que se afirme lo contrario', () => {
  inSandbox((root) => {
    cmdAdd(['Svc'], { edge: ['Tabla:writes'] });
    assert.equal(readNode(root, 'Svc').edges[0].confidence, 'unverified');
  });
});

test('--confidence se aplica a las aristas de --edge y rechaza valores invalidos', () => {
  inSandbox((root) => {
    cmdAdd(['Svc'], { edge: ['Tabla:writes'], confidence: 'certain' });
    assert.equal(readNode(root, 'Svc').edges[0].confidence, 'certain');
    assert.throws(() => cmdAdd(['Otro'], { edge: ['T:writes'], confidence: 'quiza' }), /desconocida/);
  });
});

test('cmdAdd usa siempre el id del argumento, no el del fichero leido', () => {
  inSandbox((root) => {
    cmdAdd(['Erp/Ventas'], { edge: ['X:calls'] });
    cmdAdd(['Erp_Ventas'], { edge: ['Y:calls'] });
    assert.equal(readNode(root, 'Erp/Ventas').id, 'Erp/Ventas');
    assert.equal(readNode(root, 'Erp_Ventas').id, 'Erp_Ventas');
  });
});

test('avisa si el indice fue escrito por una version de formato mas nueva', () => {
  const root = sandbox();
  fs.writeFileSync(path.join(root, '.edgelore', 'config.yaml'), 'version: 99\n');
  assert.ok(loadIndex(root).problems.some((problem) => /version de formato 99/.test(problem)));
});

test('un config sin version no genera falsos avisos', () => {
  const root = sandbox();
  fs.writeFileSync(path.join(root, '.edgelore', 'config.yaml'), '# solo un comentario\n');
  assert.deepEqual(loadIndex(root).problems, []);
});

/** Cadena tipica: ruta por literal -> pagina -> lifecycle -> tabla. */
function chainSandbox() {
  const root = sandbox();
  writeNode(root, { id: 'AppShell', edges: [{ to: 'Pagina', type: 'string-ref', at: 'AppShell.cs:42' }] });
  writeNode(root, {
    id: 'Pagina',
    edges: [{ to: 'Pagina.OnAppearing', type: 'lifecycle', trigger: 'al hacerse visible' }],
  });
  writeNode(root, { id: 'Pagina.OnAppearing', file: 'src/Pagina.cs', edges: [{ to: 'Facturas', type: 'reads' }] });
  return root;
}

test('impact recorre las dependencias de forma transitiva', () => {
  const index = loadIndex(chainSandbox());
  const result = impact(index, 'Facturas');
  assert.equal(result.affected, 3, 'OnAppearing, Pagina y AppShell dependen de la tabla');
  assert.equal(result.levels[0].entries[0].id, 'Pagina.OnAppearing');
  assert.equal(result.levels[1].entries[0].id, 'Pagina');
  assert.equal(result.levels[2].entries[0].id, 'AppShell');
});

test('impact cuenta aparte las dependencias que grep no encontraria', () => {
  const result = impact(loadIndex(chainSandbox()), 'Facturas');
  // lifecycle y string-ref son invisibles a grep; reads no cuenta como oculta.
  assert.equal(result.hidden, 2);
});

test('impact respeta el limite de profundidad y avisa de que hay mas', () => {
  const result = impact(loadIndex(chainSandbox()), 'Facturas', { maxDepth: 1 });
  assert.equal(result.affected, 1);
  assert.equal(result.truncated, true);
});

test('impact no se cuelga con ciclos', () => {
  const root = sandbox();
  writeNode(root, { id: 'A', edges: [{ to: 'B', type: 'calls' }] });
  writeNode(root, { id: 'B', edges: [{ to: 'A', type: 'calls' }] });
  const result = impact(loadIndex(root), 'A');
  assert.equal(result.affected, 1);
});

test('impact distingue un nodo sin dependientes de uno desconocido', () => {
  const root = sandbox();
  writeNode(root, { id: 'Solo', edges: [] });
  assert.equal(impact(loadIndex(root), 'Solo').known, true);
  assert.equal(impact(loadIndex(root), 'NoExiste').known, false);
});

test('la salida de impact nunca promete cobertura completa', () => {
  const index = loadIndex(chainSandbox());
  const texto = renderImpact(impact(index, 'Facturas'), index);
  assert.match(texto, /OCULTA A GREP/);
  assert.match(texto, /no todo lo que existe/);
});

test('el hook previo avisa del alcance antes de editar', () => {
  const root = chainSandbox();
  const notice = buildImpactNotice(root, loadIndex(root), [path.join(root, 'src/Pagina.cs')]);
  assert.match(notice, /ALCANCE DE Pagina.OnAppearing/);
  assert.match(notice, /Pagina/);
});

test('el hook previo calla cuando no hay nada que dependa del fichero', () => {
  const root = sandbox();
  writeNode(root, { id: 'Aislado', file: 'src/a.cs', edges: [] });
  assert.equal(buildImpactNotice(root, loadIndex(root), [path.join(root, 'src/a.cs')]), null);
});

/** Sandbox CON la integracion de Claude instalada (skill + hooks). */
function claudeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edgelore-test-'));
  cmdInit([], { dir: root, rules: ['dotnet-core'] });
  return root;
}

test('init registra los hooks previo y posterior sin tocar .gitignore', () => {
  const root = claudeSandbox();
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PostToolUse.length, 1);
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), false, 'no debe crear .gitignore');
});

test('init preserva los hooks de otras herramientas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edgelore-test-'));
  const file = path.join(root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }] },
  }));
  cmdInit([], { dir: root, rules: ['dotnet-core'] });

  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(settings.permissions.allow, ['Bash(npm test)']);
  assert.equal(settings.hooks.PostToolUse.length, 2, 'conserva el hook ajeno y anade el propio');
});

test('uninstall retira skill y hooks pero conserva los hechos', () => {
  const root = claudeSandbox();
  writeNode(root, { id: 'A', edges: [] });
  cmdUninstall([], { dir: root });

  assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'edgelore')), false);
  // El settings.json lo habiamos creado nosotros y se queda vacio: debe irse.
  assert.equal(fs.existsSync(path.join(root, '.claude', 'settings.json')), false);
  assert.equal(fs.existsSync(path.join(root, '.claude')), false, 'sin rastro fuera de .edgelore/');
  assert.ok(fs.existsSync(path.join(root, '.edgelore', 'nodes')), 'los hechos se conservan sin --all');
});

test('uninstall no toca los hooks de otras herramientas', () => {
  const root = claudeSandbox();
  const file = path.join(root, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  settings.hooks.PostToolUse.push({ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] });
  fs.writeFileSync(file, JSON.stringify(settings));

  cmdUninstall([], { dir: root });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.hooks.PostToolUse.length, 1);
  assert.equal(after.hooks.PostToolUse[0].hooks[0].command, 'prettier --write');
  assert.equal(after.hooks.PreToolUse, undefined);
});

test('uninstall --all borra tambien el almacen', () => {
  const root = sandbox();
  writeNode(root, { id: 'A', edges: [] });
  cmdUninstall([], { dir: root, all: true });
  assert.equal(fs.existsSync(path.join(root, '.edgelore')), false);
});

/** Repositorio vacio con los ficheros de proyecto que se le indiquen. */
function repoCon(ficheros) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edgelore-det-'));
  for (const [nombre, contenido] of Object.entries(ficheros)) {
    const destino = path.join(root, nombre);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, contenido);
  }
  return root;
}

test('un repositorio que no es .NET no recibe reglas de .NET', () => {
  // El motivo de la deteccion: en un proyecto de Python, cuatro ficheros de
  // reglas de .NET son ruido que alguien tendria que borrar a mano.
  const root = repoCon({ 'main.py': 'print(1)\n', 'requirements.txt': 'flask\n' });
  assert.deepEqual(detectRuleSets(root), []);

  cmdInit([], { dir: root, 'no-claude': true });
  assert.equal(fs.existsSync(path.join(root, '.edgelore', 'rules', 'dotnet-maui.yaml')), false);
});

test('init explica que hacer cuando no reconoce el stack', () => {
  const root = repoCon({ 'main.py': 'print(1)\n' });
  const salida = cmdInit([], { dir: root, 'no-claude': true }).output;
  assert.match(salida, /No se ha reconocido el stack/);
  assert.match(salida, /edgelore rules add/);
});

test('detecta MAUI y EF sin traerse las reglas de servicios de Windows', () => {
  const root = repoCon({
    'src/App.csproj': '<Project><PropertyGroup><UseMaui>true</UseMaui></PropertyGroup>'
      + '<ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore" /></ItemGroup></Project>',
  });
  const reglas = detectRuleSets(root);
  assert.ok(reglas.includes('dotnet-core'));
  assert.ok(reglas.includes('dotnet-maui'));
  assert.ok(reglas.includes('dotnet-data'));
  assert.ok(!reglas.includes('dotnet-winservice'));
});

test('detecta un servicio de Windows por su paquete de hosting', () => {
  const root = repoCon({
    'Svc.csproj': '<Project><ItemGroup><PackageReference Include="Microsoft.Extensions.Hosting.WindowsServices" /></ItemGroup></Project>',
  });
  assert.ok(detectRuleSets(root).includes('dotnet-winservice'));
});

test('la deteccion ignora los directorios de compilacion', () => {
  const root = repoCon({ 'obj/Debug/generado.csproj': '<Project><UseMaui>true</UseMaui></Project>' });
  assert.deepEqual(detectRuleSets(root), [], 'obj/ no describe el stack del repositorio');
});

test('--rules explicito manda sobre la deteccion, y "all" instala todas', () => {
  const root = repoCon({ 'main.py': 'print(1)\n' });
  cmdInit([], { dir: root, rules: ['dotnet-maui'], 'no-claude': true });
  const instaladas = fs.readdirSync(path.join(root, '.edgelore', 'rules'));
  assert.deepEqual(instaladas, ['dotnet-maui.yaml']);

  const otro = repoCon({ 'main.py': 'print(1)\n' });
  cmdInit([], { dir: otro, rules: ['all'], 'no-claude': true });
  assert.equal(fs.readdirSync(path.join(otro, '.edgelore', 'rules')).length, 4);
});

test('rules add anade sin sobreescribir lo que el equipo haya ajustado', () => {
  const root = sandbox();
  const fichero = path.join(root, '.edgelore', 'rules', 'dotnet-maui.yaml');
  fs.writeFileSync(fichero, '# ajustado por el equipo\nid: dotnet-maui\n');

  const salida = cmdRules(['add', 'dotnet-maui', 'dotnet-data'], { dir: root }).output;
  assert.match(fs.readFileSync(fichero, 'utf8'), /ajustado por el equipo/, 'nunca pisa una regla existente');
  assert.ok(fs.existsSync(path.join(root, '.edgelore', 'rules', 'dotnet-data.yaml')));
  assert.match(salida, /ya estaba/);
});

test('rules add rechaza nombres inventados', () => {
  const root = sandbox();
  const resultado = cmdRules(['add', 'inventada'], { dir: root });
  assert.equal(resultado.code, 2);
  assert.match(resultado.output, /desconocidas/);
});

test('rules list muestra instaladas y disponibles', () => {
  const root = sandbox();
  const salida = cmdRules(['list'], { dir: root }).output;
  assert.match(salida, /dotnet-maui/);
  assert.match(salida, /Disponibles para anadir/);
});

/** Nodo del que dependen `n` nodos: el caso que dispara el gasto de tokens. */
function hubCon(n) {
  const root = sandbox();
  for (let i = 0; i < n; i += 1) {
    writeNode(root, { id: `Dep${i}`, edges: [{ to: 'Hub', type: 'calls' }] });
  }
  writeNode(root, { id: 'Hub', edges: [] });
  return root;
}

test('impact acota la salida en un nodo con cientos de dependientes', () => {
  // Regresion: sin tope, un hub de 400 dependientes generaba ~7.800 tokens en
  // una sola consulta, y ese mismo texto lo inyecta el hook previo a la edicion.
  const index = loadIndex(hubCon(300));
  const texto = renderImpact(impact(index, 'Hub'), index);
  assert.ok(texto.length < 3000, `salida de ${texto.length} caracteres; deberia ir acotada`);
  assert.match(texto, /DEPENDEN DIRECTAMENTE \(300\)/, 'el total real se sigue viendo');
  assert.match(texto, /reparto por modulo/, 'con muchos dependientes se reparte, no se lista');
});

test('--all devuelve el listado entero cuando se pide', () => {
  const index = loadIndex(hubCon(300));
  const acotado = renderImpact(impact(index, 'Hub'), index);
  const completo = renderImpact(impact(index, 'Hub'), index, { limit: 0 });
  assert.ok(completo.length > acotado.length * 3);
  assert.match(completo, /Dep299/);
});

test('query tambien acota las aristas entrantes de un hub', () => {
  const index = loadIndex(hubCon(300));
  const texto = renderNeighbourhood(neighbourhood(index, 'Hub'));
  assert.ok(texto.length < 2000, `salida de ${texto.length} caracteres`);
  assert.match(texto, /LLEGA DESDE \(300\)/);
});

test('un nodo corriente no se ve afectado por el tope', () => {
  const root = sandbox();
  writeNode(root, { id: 'A', edges: [{ to: 'B', type: 'calls' }] });
  writeNode(root, { id: 'B', edges: [] });
  const index = loadIndex(root);
  const texto = renderNeighbourhood(neighbourhood(index, 'B'));
  assert.match(texto, /\bA\b/);
  assert.ok(!texto.includes('... y'), 'no debe aparecer resumen si no se recorta nada');
});

test('cada dependiente se reporta una sola vez, a su distancia mas corta', () => {
  // Regresion: un nodo alcanzable por varias rutas salia repetido en niveles
  // sucesivos, inflando la salida sin anadir informacion.
  const root = sandbox();
  writeNode(root, { id: 'Directo', edges: [{ to: 'Objetivo', type: 'calls' }] });
  writeNode(root, { id: 'Intermedio', edges: [{ to: 'Objetivo', type: 'calls' }] });
  writeNode(root, { id: 'Objetivo', edges: [] });
  // Directo tambien es alcanzable a traves de Intermedio.
  writeNode(root, { id: 'Directo2', edges: [{ to: 'Intermedio', type: 'calls' }] });
  writeNode(root, { id: 'Intermedio2', edges: [{ to: 'Directo', type: 'calls' }] });

  const resultado = impact(loadIndex(root), 'Objetivo');
  const apariciones = resultado.levels.flatMap((nivel) => nivel.entries.map((e) => e.id));
  assert.equal(new Set(apariciones).size, apariciones.length, 'ningun nodo debe repetirse entre niveles');
});

test('el aviso del hook es mas estricto que una consulta a mano', () => {
  const root = hubCon(300);
  writeNode(root, { id: 'Hub', file: 'src/hub.cs', edges: [] });
  const index = loadIndex(root);
  const aviso = buildImpactNotice(root, index, [path.join(root, 'src/hub.cs')]);
  // Entra en el contexto sin que nadie lo pida: debe ser minusculo.
  assert.ok(aviso.length < 1500, `el aviso automatico ocupa ${aviso.length} caracteres`);
});

test('moduleOf deduce el modulo de un id jerarquico', () => {
  assert.equal(moduleOf('Erp.Ventas.Pagina7.OnAppearing'), 'Erp.Ventas');
  assert.equal(moduleOf('Lib.Core.Guard'), 'Lib.Core');
  assert.equal(moduleOf('Auditoria'), 'Auditoria');
  assert.equal(moduleOf('Base.Ui'), 'Base');
});

test('el reparto por modulo no oculta modulos enteros por orden alfabetico', () => {
  // Regresion: listar los primeros N por orden alfabetico hacia que en un
  // monorepo salieran todos del mismo modulo, y quien lo leia concluia que el
  // cambio solo afectaba a ese. Es peor que no decir nada.
  const root = sandbox();
  for (const modulo of ['Erp.Almacen', 'Erp.Compras', 'Erp.Ventas']) {
    for (let i = 0; i < 100; i += 1) {
      writeNode(root, { id: `${modulo}.Pagina${i}`, edges: [{ to: 'Base.PageBase', type: 'implements' }] });
    }
  }
  writeNode(root, { id: 'Base.PageBase', edges: [] });

  const index = loadIndex(root);
  const texto = renderImpact(impact(index, 'Base.PageBase'), index);
  for (const modulo of ['Erp.Almacen', 'Erp.Compras', 'Erp.Ventas']) {
    assert.match(texto, new RegExp(modulo.replace('.', '\\.')), `${modulo} debe aparecer en el reparto`);
  }
  assert.match(texto, /DEPENDEN DIRECTAMENTE \(300\)/);
});

test('el disparador comun se escribe una vez, no por cada linea', () => {
  const root = sandbox();
  for (let i = 0; i < 50; i += 1) {
    writeNode(root, {
      id: `Erp.Mod.Pagina${i}`,
      edges: [{ to: 'Objetivo', type: 'lifecycle', trigger: 'el runtime la invoca al hacerse visible' }],
    });
  }
  writeNode(root, { id: 'Objetivo', edges: [] });
  const index = loadIndex(root);
  const texto = renderImpact(impact(index, 'Objetivo'), index);
  const veces = texto.split('el runtime la invoca al hacerse visible').length - 1;
  assert.equal(veces, 1, 'el trigger compartido no debe repetirse por cada dependiente');
});

test('query reparte por modulo cuando un nodo tiene muchos vecinos', () => {
  const root = sandbox();
  for (const modulo of ['Erp.A', 'Erp.B']) {
    for (let i = 0; i < 40; i += 1) {
      writeNode(root, { id: `${modulo}.S${i}`, edges: [{ to: 'Compartido', type: 'calls' }] });
    }
  }
  writeNode(root, { id: 'Compartido', edges: [] });
  const texto = renderNeighbourhood(neighbourhood(loadIndex(root), 'Compartido'));
  assert.match(texto, /reparto por modulo \(80\)/);
  assert.match(texto, /Erp\.A/);
  assert.match(texto, /Erp\.B/);
});

test('impact expone la ruta de cada dependiente, no solo su id', () => {
  // Sin la ruta, el alcance no es una lista de trabajo: hay que resolver cada
  // id por separado para saber que fichero abrir.
  const root = sandbox();
  writeNode(root, { id: 'Erp.A.Pagina', file: 'src/A/Pagina.cs', edges: [{ to: 'Base', type: 'implements' }] });
  writeNode(root, { id: 'Base', edges: [] });
  const entrada = impact(loadIndex(root), 'Base').levels[0].entries[0];
  assert.equal(entrada.file, 'src/A/Pagina.cs');
});

test('la lista de trabajo deduplica por fichero', () => {
  const root = sandbox();
  // Dos nodos que viven en el mismo fichero: un solo sitio que abrir.
  writeNode(root, { id: 'Erp.A.Pagina', file: 'src/A/Pagina.cs', edges: [{ to: 'Base', type: 'implements' }] });
  writeNode(root, {
    id: 'Erp.A.Pagina.OnAppearing',
    file: 'src/A/Pagina.cs',
    edges: [{ to: 'Base', type: 'lifecycle', trigger: 'al hacerse visible' }],
  });
  writeNode(root, { id: 'Base', edges: [] });

  const lista = workList(impact(loadIndex(root), 'Base'));
  assert.equal(lista.files.length, 1, 'un fichero, aunque lo toquen dos nodos');
  assert.equal(lista.total, 2);
  assert.equal(lista.files[0].file, 'src/A/Pagina.cs');
});

test('la lista de trabajo se acota por modulo y por profundidad', () => {
  const root = sandbox();
  writeNode(root, { id: 'Erp.Ventas.S', file: 'src/V/S.cs', edges: [{ to: 'Base', type: 'calls' }] });
  writeNode(root, { id: 'Erp.Compras.S', file: 'src/C/S.cs', edges: [{ to: 'Base', type: 'calls' }] });
  writeNode(root, { id: 'Erp.Ventas.Lejano', file: 'src/V/L.cs', edges: [{ to: 'Erp.Ventas.S', type: 'calls' }] });
  writeNode(root, { id: 'Base', edges: [] });
  const resultado = impact(loadIndex(root), 'Base');

  assert.equal(workList(resultado, { module: 'Erp.Ventas' }).files.length, 2);
  assert.equal(workList(resultado, { maxDepth: 1 }).files.length, 2);
  assert.equal(workList(resultado, { module: 'Erp.Ventas', maxDepth: 1 }).files.length, 1);
});

test('la lista de trabajo cuenta aparte los dependientes sin fichero', () => {
  const root = sandbox();
  writeNode(root, { id: 'Tabla', edges: [{ to: 'Base', type: 'reads' }] });
  writeNode(root, { id: 'Base', edges: [] });
  const lista = workList(impact(loadIndex(root), 'Base'));
  assert.equal(lista.files.length, 0);
  assert.equal(lista.sinFichero, 1);
  assert.match(renderWorkList({ id: 'Base' }, lista), /sin fichero declarado/);
});

test('rename arrastra los miembros del tipo', () => {
  // Renombrar una clase sin arrastrar `Clase.OnAppearing` dejaria huerfano al
  // hijo, y eso es siempre un error, no una eleccion del usuario.
  inSandbox((root) => {
    writeNode(root, { id: 'Erp.Ui.Vieja', file: 'a.cs', edges: [] });
    writeNode(root, { id: 'Erp.Ui.Vieja.OnAppearing', edges: [] });
    cmdRename(['Erp.Ui.Vieja', 'Erp.Ui.Nueva'], {});

    assert.ok(readNode(root, 'Erp.Ui.Nueva'), 'la clase se renombra');
    assert.ok(readNode(root, 'Erp.Ui.Nueva.OnAppearing'), 'el miembro sigue al tipo');
    assert.equal(readNode(root, 'Erp.Ui.Vieja'), null, 'no queda el id viejo');
  });
});

test('rename reapunta todo lo que referenciaba al id viejo', () => {
  inSandbox((root) => {
    writeNode(root, { id: 'Vieja', edges: [] });
    writeNode(root, { id: 'Otro', edges: [{ to: 'Vieja', type: 'calls' }] });
    writeNode(root, { id: 'Tercero', edges: [{ to: 'Vieja.Miembro', type: 'calls' }] });
    cmdRename(['Vieja', 'Nueva'], {});

    assert.equal(readNode(root, 'Otro').edges[0].to, 'Nueva');
    assert.equal(readNode(root, 'Tercero').edges[0].to, 'Nueva.Miembro');
    assert.deepEqual(danglingIds(loadIndex(root)).filter((id) => id.startsWith('Vieja')), []);
  });
});

test('rename funciona sobre un id que solo existe como destino de aristas', () => {
  inSandbox((root) => {
    writeNode(root, { id: 'Origen', edges: [{ to: 'SoloReferenciado', type: 'calls' }] });
    const salida = cmdRename(['SoloReferenciado', 'ConNombreBueno'], {}).output;
    assert.equal(readNode(root, 'Origen').edges[0].to, 'ConNombreBueno');
    assert.match(salida, /no tenia ficha propia/);
  });
});

test('rename se niega si el destino ya existe', () => {
  inSandbox((root) => {
    writeNode(root, { id: 'A', edges: [] });
    writeNode(root, { id: 'B', edges: [] });
    const resultado = cmdRename(['A', 'B'], {});
    assert.equal(resultado.code, 1);
    assert.match(resultado.output, /Ya existen hechos/);
    assert.ok(readNode(root, 'A'), 'no debe tocar nada al negarse');
  });
});

test('rename avisa cuando el id no aparece en ningun sitio', () => {
  inSandbox(() => {
    const resultado = cmdRename(['NoExiste', 'Nuevo'], {});
    assert.equal(resultado.code, 1);
    assert.match(resultado.output, /no aparece en el indice/);
  });
});

test('rename conserva las notas del hecho', () => {
  inSandbox((root) => {
    writeNode(root, { id: 'Vieja', edges: [] }, 'El porque, que es lo caro de recuperar.');
    cmdRename(['Vieja', 'Nueva'], {});
    assert.match(readNode(root, 'Nueva').notes, /lo caro de recuperar/);
  });
});

test('link no carga el indice entero para avisar del destino', () => {
  // Antes leia los miles de ficheros del almacen solo para imprimir un aviso de
  // una linea, en uno de los comandos que mas se repiten al dia.
  inSandbox((root) => {
    for (let i = 0; i < 40; i += 1) writeNode(root, { id: `Relleno${i}`, edges: [] });
    writeNode(root, { id: 'Origen', edges: [] });

    const sinFicha = cmdLink(['Origen', 'Destino', 'calls'], {}).output;
    assert.match(sinFicha, /aun no tiene ficha propia/);

    writeNode(root, { id: 'Destino', edges: [] });
    const conFicha = cmdLink(['Origen', 'Destino', 'calls'], {}).output;
    assert.ok(!conFicha.includes('aun no tiene ficha'), 'sin aviso cuando el destino existe');
  });
});

test('path distingue "no existe" de "no hay camino"', () => {
  const root = sandbox();
  writeNode(root, { id: 'A', edges: [] });
  writeNode(root, { id: 'Z', edges: [] });
  const index = loadIndex(root);

  // Existen los dos pero no conectan: eso si es "no hay camino".
  assert.equal(findPath(index, 'A', 'Z'), null);
  // Y un extremo inexistente debe detectarse antes de recorrer nada.
  assert.equal(index.nodes.has('Fantasma') || index.incoming.has('Fantasma'), false);
});

test('la sugerencia funciona ante una errata, no solo por subcadena', () => {
  // `search` solo casa subcadenas, asi que ante "Pagna7" por "Pagina7" no
  // devolvia nada: el "quiza te refieres a" fallaba justo en su caso principal.
  const root = sandbox();
  writeNode(root, { id: 'Erp.Ventas.Pagina7', edges: [] });
  const index = loadIndex(root);
  assert.deepEqual(search(index, 'Erp.Ventas.Pagna7'), [], 'por subcadena no hay nada');
  assert.deepEqual(didYouMean(index, 'Erp.Ventas.Pagna7'), ['Erp.Ventas.Pagina7']);
});

test('a igual parecido en el nombre corto gana el del modulo correcto', () => {
  // Regresion: los cuatro modulos empataban en "Pagina7" y el orden alfabetico
  // ponia el modulo equivocado primero.
  const root = sandbox();
  for (const modulo of ['Erp.Almacen', 'Erp.Compras', 'Erp.Contabilidad', 'Erp.Ventas']) {
    writeNode(root, { id: `${modulo}.Pagina7`, edges: [] });
  }
  const sugerencias = didYouMean(loadIndex(root), 'Erp.Ventas.Pagna7', { limit: 4 });
  assert.equal(sugerencias[0], 'Erp.Ventas.Pagina7', 'el del modulo pedido va primero');
});

test('la sugerencia no cuela candidatos sin parecido real', () => {
  const root = sandbox();
  writeNode(root, { id: 'Base.Ui.PageBase', edges: [] });
  writeNode(root, { id: 'Erp.Almacen.Pagina0', edges: [] });
  const sugerencias = didYouMean(loadIndex(root), 'Basse.Ui.PageBase', { limit: 5 });
  assert.deepEqual(sugerencias, ['Base.Ui.PageBase']);
});

test('la sugerencia por subcadena sigue teniendo prioridad', () => {
  const root = sandbox();
  writeNode(root, { id: 'Erp.Ventas.PagoService', edges: [] });
  assert.deepEqual(didYouMean(loadIndex(root), 'PagoService'), ['Erp.Ventas.PagoService']);
});

test('validate no rompe el build porque el codigo se haya movido', () => {
  // Simulado sobre 6 meses de uso, el 32% de los hechos acababa apuntando a
  // ficheros borrados. Romper el CI por eso lo deja en rojo permanente desde el
  // primer mes, y un CI en rojo permanente se ignora.
  inSandbox((root) => {
    writeNode(root, { id: 'Erp.A.Borrada', file: 'src/borrada.cs', edges: [] });
    const resultado = cmdValidate([], {});
    assert.equal(resultado.code, 0, 'la desincronizacion informa, no rompe');
    assert.match(resultado.output, /ya no existen/);
    assert.equal(cmdValidate([], { strict: true }).code, 1, 'con --strict si rompe');
  });
});

test('validate si rompe el build por un hecho mal escrito', () => {
  inSandbox((root) => {
    fs.writeFileSync(path.join(root, '.edgelore', 'nodes', 'malo.md'), 'esto no es frontmatter\n');
    const resultado = cmdValidate([], {});
    assert.equal(resultado.code, 1);
    assert.match(resultado.output, /error\(es\) de esquema/);
  });
});

test('los miembros generados por reglas no cuentan como sospechosos', () => {
  // Eran 148 de 148 en la simulacion: presentarlos como problema hace que nadie
  // mire la lista, y ahi es donde se esconde el resto de renombrado que si importa.
  const root = sandbox();
  writeNode(root, {
    id: 'Erp.A.Pagina',
    kind: 'maui-page',
    edges: [{ to: 'Erp.A.Pagina.OnAppearing', type: 'lifecycle', trigger: 'al aparecer', source: 'rule:dotnet-maui' }],
  });
  writeNode(root, { id: 'Otro', edges: [{ to: 'Erp.A.RestoDeRenombrado', type: 'calls' }] });

  const { esperados, sospechosos } = classifyDangling(loadIndex(root));
  assert.deepEqual(esperados, ['Erp.A.Pagina.OnAppearing']);
  assert.deepEqual(sospechosos, ['Erp.A.RestoDeRenombrado']);
});

test('prune lista sin borrar y solo borra con --apply', () => {
  inSandbox((root) => {
    writeNode(root, { id: 'Fantasma', file: 'src/ya-no-esta.cs', edges: [] }, 'El porque.');
    const listado = cmdPrune([], {});
    assert.equal(listado.code, 1);
    assert.match(listado.output, /Nada se ha borrado/);
    assert.ok(readNode(root, 'Fantasma'), 'sin --apply no toca nada');

    cmdPrune([], { apply: true });
    assert.equal(readNode(root, 'Fantasma'), null);
  });
});

test('prune avisa de las aristas que quedarian colgando al borrar', () => {
  inSandbox((root) => {
    writeNode(root, { id: 'Fantasma', file: 'src/no.cs', edges: [] });
    writeNode(root, { id: 'Citante', edges: [{ to: 'Fantasma', type: 'calls' }] });
    assert.match(cmdPrune([], {}).output, /1 arista\(s\) apuntan a el/);
    assert.match(cmdPrune([], { apply: true }).output, /quedan colgando/);
  });
});

test('prune no dice nada cuando todo esta sincronizado', () => {
  inSandbox((root) => {
    writeNode(root, { id: 'SinFichero', edges: [] });
    assert.match(cmdPrune([], {}).output, /Ningun hecho apunta/);
  });
});

// --- Texto libre acotado --------------------------------------------------
//
// `summary` lo acota validateNode a 300 caracteres, pero `note`, `trigger` y
// sobre todo `notes` -el cuerpo entero del markdown- no los acotaba nada. Es la
// unica via por la que una consulta podia devolver miles de tokens, y ademas es
// texto que el hook previo a la edicion inyecta en el contexto sin pedir
// permiso. El README prometia que ningun comando puede devolver miles de
// lineas; estas pruebas hacen que sea verdad.

test('clamp deja intacto lo que cabe y anota cuanto recorta', () => {
  assert.equal(clamp('corto', 100), 'corto');
  const largo = clamp('x'.repeat(500), 100);
  assert.ok(largo.length < 160, `recorte de ${largo.length} caracteres`);
  assert.match(largo, /\[\.\.\.\+\d+ caracteres\]/);
});

test('clamp no parte una palabra por la mitad si puede evitarlo', () => {
  const texto = clamp(`${'palabra '.repeat(50)}`, 100);
  assert.ok(!/pala\b/.test(texto.split(' [...')[0].split(' ').pop()));
});

test('query acota una nota de nodo desmesurada', () => {
  const root = sandbox();
  writeNode(root, { id: 'A', edges: [{ to: 'B', type: 'calls' }] }, 'linea muy larga. '.repeat(2000));
  const texto = renderNeighbourhood(neighbourhood(loadIndex(root), 'A'));
  assert.ok(texto.length < 2500, `salida de ${texto.length} caracteres; deberia ir acotada`);
  assert.match(texto, /--all para verlo entero/);
});

test('--all devuelve la nota entera', () => {
  const root = sandbox();
  const cuerpo = 'linea muy larga. '.repeat(2000);
  writeNode(root, { id: 'A', edges: [{ to: 'B', type: 'calls' }] }, cuerpo);
  const texto = renderNeighbourhood(neighbourhood(loadIndex(root), 'A'), { limit: 0 });
  assert.ok(texto.length > 30000, 'con --all no se recorta nada');
});

test('query acota tambien el texto libre de una arista', () => {
  const root = sandbox();
  writeNode(root, {
    id: 'A',
    edges: [{ to: 'B', type: 'string-ref', at: 'src/A.cs:1', note: 'nota kilometrica. '.repeat(500) }],
  });
  const texto = renderNeighbourhood(neighbourhood(loadIndex(root), 'A'));
  assert.ok(texto.length < 1500, `salida de ${texto.length} caracteres`);
  assert.match(texto, /\[\.\.\.\+\d+ caracteres\]/);
});

test('impact acota el texto libre que inyecta el hook', () => {
  const root = sandbox();
  writeNode(root, {
    id: 'Dep',
    edges: [{ to: 'Hub', type: 'lifecycle', trigger: 'disparador larguisimo. '.repeat(500) }],
  });
  writeNode(root, { id: 'Hub', edges: [] });
  const index = loadIndex(root);
  const texto = renderImpact(impact(index, 'Hub'), index);
  assert.ok(texto.length < 1800, `salida de ${texto.length} caracteres`);
  assert.match(texto, /\[\.\.\.\+\d+ caracteres\]/);
});

// --- Decaimiento de la confianza ------------------------------------------
//
// Un `certain` sellado hace tres anos se lee con la misma seguridad que uno de
// ayer, y esa es justo la forma en que un indice curado miente. No se puede
// recalcular la verdad de un hecho sin mirarlo; lo unico honesto es dejar de
// imprimir la etiqueta a secas. El dato ya estaba en verified.date.

test('ageInDays y formatAge convierten un sello en algo legible', () => {
  const ahora = Date.parse('2026-08-26T00:00:00Z');
  assert.equal(ageInDays('2026-08-20', ahora), 6);
  assert.equal(ageInDays('sin fecha', ahora), null);
  assert.equal(ageInDays(undefined, ahora), null);
  assert.match(formatAge(6), /hace 6 dias/);
  assert.match(formatAge(700), /ano/);
});

test('decayLabel calla mientras el sello es reciente', () => {
  const ahora = Date.parse('2026-08-26T00:00:00Z');
  assert.equal(decayLabel({ date: '2026-06-01' }, { now: ahora }), null);
  assert.equal(decayLabel({}, { now: ahora }), null, 'sin fecha no se inventa antiguedad');
  assert.match(decayLabel({ date: '2023-02-01' }, { now: ahora }), /sin reverificar/);
});

test('query marca un hecho verificado hace demasiado', () => {
  const root = sandbox();
  writeNode(root, {
    id: 'A',
    edges: [{ to: 'B', type: 'calls', confidence: 'certain' }],
    verified: { commit: 'abc1234', date: '2023-02-01' },
  });
  const texto = renderNeighbourhood(neighbourhood(loadIndex(root), 'A'), {
    now: Date.parse('2026-08-26T00:00:00Z'),
  });
  assert.match(texto, /sin reverificar desde/);
});

test('query no marca nada cuando el sello es reciente', () => {
  const root = sandbox();
  writeNode(root, {
    id: 'A',
    edges: [{ to: 'B', type: 'calls' }],
    verified: { commit: 'abc1234', date: '2026-08-01' },
  });
  const texto = renderNeighbourhood(neighbourhood(loadIndex(root), 'A'), {
    now: Date.parse('2026-08-26T00:00:00Z'),
  });
  assert.ok(!texto.includes('sin reverificar'), texto);
});

test('query dice cuando un hecho no lo ha confirmado nadie', () => {
  const root = sandbox();
  writeNode(root, { id: 'A', edges: [{ to: 'B', type: 'calls' }] });
  const texto = renderNeighbourhood(neighbourhood(loadIndex(root), 'A'));
  assert.match(texto, /SIN VERIFICAR: nadie ha confirmado/);
});

test('impact resume cuantos dependientes estan sin reverificar', () => {
  const root = sandbox();
  writeNode(root, {
    id: 'Viejo',
    edges: [{ to: 'Hub', type: 'calls' }],
    verified: { commit: 'aaa1111', date: '2023-02-01' },
  });
  writeNode(root, { id: 'Nunca', edges: [{ to: 'Hub', type: 'calls' }] });
  writeNode(root, { id: 'Hub', edges: [] });
  const index = loadIndex(root);
  const texto = renderImpact(impact(index, 'Hub'), index, { now: Date.parse('2026-08-26T00:00:00Z') });
  assert.match(texto, /1 sin reverificar desde hace mas de 12 meses/);
  assert.match(texto, /1 sin verificar nunca/);
});

test('el recuento de decaidos cuenta nodos, no aristas', () => {
  // El mismo dependiente llega por dos motivos distintos y los dos se listan
  // -son dos formas de romperlo- pero es un unico sitio que abrir. Contando
  // aristas, el aviso decia 2 donde hay 1, justo en la linea que manda a
  // comprobarlos.
  const root = sandbox();
  writeNode(root, {
    id: 'Erp.Ventas.Pagina',
    edges: [
      { to: 'Hub', type: 'implements' },
      { to: 'Hub', type: 'reads' },
    ],
  });
  writeNode(root, { id: 'Hub', edges: [] });
  const index = loadIndex(root);
  const result = impact(index, 'Hub');
  assert.equal(result.levels[0].entries.length, 2, 'las dos aristas se siguen listando');
  const texto = renderImpact(result, index);
  assert.match(texto, /Del dependiente alcanzado, 1 sin verificar nunca\. Comprobalo /, texto);
  assert.ok(!texto.includes('2 sin verificar nunca'), texto);
});

test('el recuento de decaidos habla de alcanzados, tambien con la lista recortada', () => {
  // Cuando un nivel se reparte por modulo no se imprime ni un nombre, asi que
  // "de los dependientes listados" prometia una lista que no estaba ahi.
  const root = sandbox();
  for (let i = 0; i < 4; i += 1) {
    writeNode(root, { id: `Erp.Ventas.P${i}`, edges: [{ to: 'Hub', type: 'implements' }] });
  }
  writeNode(root, { id: 'Hub', edges: [] });
  const index = loadIndex(root);
  const texto = renderImpact(impact(index, 'Hub'), index, { limit: 2 });
  assert.match(texto, /reparto por modulo/, texto);
  assert.match(texto, /De los 4 dependientes alcanzados, 4 sin verificar nunca/, texto);
  assert.ok(!texto.includes('dependientes listados'), texto);
});

test('validate calla sobre la antiguedad salvo que se le pida', () => {
  // Misma regla que con la desincronizacion: todo hecho envejece, asi que una
  // lista de caducados en la salida por defecto crece cada dia hasta que se
  // ignora, y arrastra consigo la atencion sobre lo que si es accionable.
  inSandbox((root) => {
    writeNode(root, {
      id: 'A',
      edges: [{ to: 'B', type: 'calls' }],
      verified: { commit: 'aaa1111', date: '2019-01-01' },
    });
    writeNode(root, { id: 'B', edges: [] });

    const callado = cmdValidate([], {});
    assert.ok(!callado.output.includes('sin reverificar'), callado.output);
    assert.equal(callado.code, 0);

    const pedido = cmdValidate([], { 'max-age': 365 });
    assert.match(pedido.output, /1 hecho\(s\) sin reverificar desde hace mas de 365 dias/);
    assert.equal(pedido.code, 0, 'informar no rompe el build');

    assert.equal(cmdValidate([], { 'max-age': 365, strict: true }).code, 1, 'con --strict si rompe');
  });
});

// --- Huella del contenido --------------------------------------------------
//
// El commit era el MECANISMO para detectar que un hecho se quedo atras, y era
// un mal mecanismo: obligaba a git y se evaporaba al reescribir la historia.
// Ahora el mecanismo es la huella del fichero y git solo enriquece.

test('la huella ignora los finales de linea y el BOM', () => {
  // Sin esto, un equipo mixto Windows/Linux veria TODOS los hechos caducados al
  // cambiar de maquina: `core.autocrlf=true` materializa el arbol con CRLF.
  const lf = fingerprintOf(normalizeContent(Buffer.from('a\nb\n', 'utf8')));
  const crlf = fingerprintOf(normalizeContent(Buffer.from('a\r\nb\r\n', 'utf8')));
  const bom = fingerprintOf(normalizeContent(Buffer.from('﻿a\nb\n', 'utf8')));
  assert.equal(lf, crlf);
  assert.equal(lf, bom);
  assert.match(lf, /^sha256:[0-9a-f]{16}$/);
});

test('la huella si cambia cuando cambia el contenido', () => {
  assert.notEqual(
    fingerprintOf(normalizeContent(Buffer.from('a\n'))),
    fingerprintOf(normalizeContent(Buffer.from('b\n'))),
  );
});

test('verify sella con la huella en un repositorio sin git', () => {
  // Antes salia con codigo 1 diciendo "esto no es un repositorio git", asi que
  // fuera de git ningun hecho llevaba sello y `stale` no podia decir nada.
  inSandbox((root) => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'class A {}\n');
    cmdAdd(['Erp.A'], { file: 'src/A.cs' });
    const resultado = cmdVerify(['Erp.A']);
    assert.equal(resultado.code ?? 0, 0, resultado.output);
    const node = readNode(root, 'Erp.A');
    assert.match(node.verified.fingerprint, /^sha256:[0-9a-f]{16}$/);
    assert.equal(node.verified.commit, undefined, 'sin git no hay commit que anotar');
  });
});

test('stale detecta el cambio por huella, sin preguntar a git', () => {
  inSandbox((root) => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'class A {}\n');
    cmdAdd(['Erp.A'], { file: 'src/A.cs' });

    assert.equal(cmdStale([], {}).code ?? 0, 0, 'recien sellado, nada que revisar');

    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'class A { void Nuevo() {} }\n');
    const resultado = cmdStale([], {});
    assert.equal(resultado.code, 1);
    assert.match(resultado.output, /Erp\.A/);
  });
});

test('stale no confunde un fichero borrado con un hecho caducado', () => {
  // Eso es desincronizacion, y de eso informan validate y prune.
  inSandbox((root) => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'class A {}\n');
    cmdAdd(['Erp.A'], { file: 'src/A.cs' });
    fs.rmSync(path.join(root, 'src', 'A.cs'));
    assert.equal(cmdStale([], {}).code ?? 0, 0, cmdStale([], {}).output);
  });
});

test('un hecho sellado solo con commit sigue siendo valido', () => {
  // Compatibilidad: los indices escritos antes de que existieran las huellas no
  // pueden quedar invalidados de golpe.
  const problemas = validateNode({ id: 'A', verified: { commit: 'abc1234', date: '2026-01-01' } });
  assert.deepEqual(problemas, []);
});

test('una huella con formato invalido si rompe el esquema', () => {
  const problemas = validateNode({ id: 'A', verified: { fingerprint: 'sha1:cosas', date: '2026-01-01' } });
  assert.equal(problemas.length, 1);
  assert.match(problemas[0], /fingerprint invalida/);
});

test('las claves del sello salen siempre en el mismo orden', () => {
  const verified = normalizeNode({
    id: 'A',
    verified: { date: '2026-01-01', by: 'a@b.c', commit: 'abc1234', fingerprint: 'sha256:0123456789abcdef' },
  }).verified;
  assert.deepEqual(Object.keys(verified), ['fingerprint', 'commit', 'date', 'by']);
});

// --- Anclas de contenido ---------------------------------------------------
//
// `at: src/A.cs:42` deja de ser cierto en cuanto alguien anade una linea
// arriba, y `at` es el campo de las aristas string-ref, las de mas valor del
// indice. Hasta ahora NADA comprobaba que la linea 42 fuera la correcta: no es
// que se desincronizara, es que nunca se verifico.

test('parseAt separa fichero y linea, y rechaza lo que no lo es', () => {
  assert.deepEqual(parseAt('src/A.cs:42'), { file: 'src/A.cs', line: 42 });
  assert.deepEqual(parseAt('C:/x/A.cs:7'), { file: 'C:/x/A.cs', line: 7 }, 'rutas de Windows');
  assert.equal(parseAt('src/A.cs'), null);
  assert.equal(parseAt('src/A.cs:0'), null);
  assert.equal(parseAt(undefined), null);
});

test('el ancla ignora la reindentacion', () => {
  // Reindentar un bloque es el cambio mas frecuente que no altera lo que la
  // linea dice; si contara como cambio, el ancla seria inservible.
  assert.equal(normalizeAnchor('    foo(  1 , 2 )  '), normalizeAnchor('foo( 1 , 2 )'));
});

test('link captura el ancla solo, sin que nadie la escriba', () => {
  inSandbox((root) => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'uno\ndos\nRegisterRoute("detalle")\ncuatro\n');
    cmdLink(['AppShell', 'DetallePage', 'string-ref'], { at: 'src/A.cs:3' });
    const edge = readNode(root, 'AppShell').edges[0];
    assert.equal(edge.anchor, 'RegisterRoute("detalle")');
  });
});

test('una linea en blanco no se guarda como ancla', () => {
  // No ancla nada: se movera sola en cuanto alguien toque el fichero, y
  // guardarla daria una falsa sensacion de control.
  inSandbox((root) => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'uno\n\ntres\n');
    cmdLink(['A', 'B', 'string-ref'], { at: 'src/A.cs:2', note: 'algo' });
    assert.equal(readNode(root, 'A').edges[0].anchor, undefined);
  });
});

test('relocate reajusta una referencia desplazada', () => {
  inSandbox((root) => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'uno\ndos\nRegisterRoute("detalle")\n');
    cmdLink(['AppShell', 'DetallePage', 'string-ref'], { at: 'src/A.cs:3' });

    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'nueva\notra\nuno\ndos\nRegisterRoute("detalle")\n');
    assert.match(cmdRelocate([], {}).output, /se han desplazado/);
    assert.equal(readNode(root, 'AppShell').edges[0].at, 'src/A.cs:3', 'sin --apply no toca nada');

    cmdRelocate([], { apply: true });
    assert.equal(readNode(root, 'AppShell').edges[0].at, 'src/A.cs:5');
    assert.match(cmdRelocate([], {}).output, /apuntando a la linea correcta/);
  });
});

test('relocate distingue desplazada de perdida', () => {
  // Es toda la gracia: el desplazamiento es constante y no significa nada; que
  // el texto desaparezca del fichero si.
  inSandbox((root) => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'uno\nRegisterRoute("detalle")\n');
    cmdLink(['AppShell', 'DetallePage', 'string-ref'], { at: 'src/A.cs:2' });

    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'uno\notra cosa\n');
    const resultado = cmdRelocate([], {});
    assert.equal(resultado.code, 1);
    assert.match(resultado.output, /ya no aparece en el fichero/);
  });
});

test('con varias lineas identicas se elige la mas cercana a la original', () => {
  inSandbox((root) => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'x()\nrelleno\nrelleno\nrelleno\nx()\n');
    cmdLink(['A', 'B', 'string-ref'], { at: 'src/A.cs:5' });
    // Se inserta una linea al principio: la referencia pasa de la 5 a la 6, y
    // la otra ocurrencia identica sigue arriba. Elegir la primera del fichero
    // mandaria a mirar el sitio equivocado.
    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'nueva\nx()\nrelleno\nrelleno\nrelleno\nx()\n');
    cmdRelocate([], { apply: true });
    assert.equal(readNode(root, 'A').edges[0].at, 'src/A.cs:6');
  });
});

test('validate informa de las referencias rotas sin romper el build', () => {
  inSandbox((root) => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'RegisterRoute("detalle")\n');
    cmdLink(['A', 'B', 'string-ref'], { at: 'src/A.cs:1' });
    fs.writeFileSync(path.join(root, 'src', 'A.cs'), 'otra cosa\n');

    const resultado = cmdValidate([], {});
    assert.equal(resultado.code, 0, 'informa, no rompe');
    assert.match(resultado.output, /ya no aparece donde apuntan/);
    assert.equal(cmdValidate([], { strict: true }).code, 1);
  });
});

test('anchor sin at no tiene sentido y el esquema lo dice', () => {
  const problemas = validateNode({ id: 'A', edges: [{ to: 'B', type: 'calls', anchor: 'algo' }] });
  assert.equal(problemas.length, 1);
  assert.match(problemas[0], /anchor sin at/);
});

// --- suggest ---------------------------------------------------------------
//
// "Registra primero lo que ya os ha hecho perder tiempo" era buen consejo sin
// herramienta detras. Esto convierte la adopcion -el mayor obstaculo declarado-
// en una lista de trabajo, con senales que ya existen y sin parsear nada.

test('suggest ordena por commits x personas, no solo por commits', () => {
  // Un fichero que toca una sola persona muchas veces es su area; uno que tocan
  // varias es conocimiento compartido que se re-aprende cada vez, y ahi es
  // donde un indice paga.
  const orden = ordenarPorRotacion([
    { file: 'solo.cs', commits: 20, authors: 1 },
    { file: 'compartido.cs', commits: 12, authors: 4 },
    { file: 'quieto.cs', commits: 2, authors: 2 },
  ]);
  assert.deepEqual(orden.map((e) => e.file), ['compartido.cs', 'solo.cs', 'quieto.cs']);
});

test('suggest no propone documentacion ni ficheros de bloqueo', () => {
  // Un README no se ejecuta: no puede tener ninguna de las relaciones ocultas
  // que Edgelore existe para registrar. Un lockfile lo genera una herramienta y
  // encabezaria cualquier ranking de rotacion sin que nadie aprenda nada.
  assert.equal(sinInteresParaIndice('README.md'), true);
  assert.equal(sinInteresParaIndice('docs/guia.rst'), true);
  assert.equal(sinInteresParaIndice('package-lock.json'), true);
  assert.equal(sinInteresParaIndice('src/App/yarn.lock'), true);
  assert.equal(sinInteresParaIndice('src/A.cs'), false);
  assert.equal(sinInteresParaIndice('appsettings.json'), false, 'la configuracion si importa');
});

test('suggest saca los hechos con mas dependientes que nadie confirma', () => {
  inSandbox((root) => {
    writeNode(root, { id: 'Hoja', edges: [{ to: 'X', type: 'calls' }] });
    writeNode(root, { id: 'Hub', edges: [] });
    for (let i = 0; i < 4; i += 1) {
      writeNode(root, { id: `Dep${i}`, edges: [{ to: 'Hub', type: 'calls' }] });
    }
    const salida = cmdSuggest([], {}).output;
    assert.match(salida, /4 dependientes {2}Hub {2}\(sin verificar nunca\)/);
    // Una hoja sin dependientes tambien esta sin verificar, pero revisarla
    // primero no aporta nada: el orden es lo que hace util la lista.
    assert.ok(!salida.includes('Hoja'), salida);
  });
});

test('suggest calla sobre lo que ya esta verificado y al dia', () => {
  inSandbox((root) => {
    writeNode(root, {
      id: 'Hub',
      edges: [],
      verified: { fingerprint: 'sha256:0123456789abcdef', date: new Date().toISOString().slice(0, 10) },
    });
    writeNode(root, { id: 'Dep', edges: [{ to: 'Hub', type: 'calls' }] });
    assert.match(cmdSuggest([], {}).output, /estan verificados y al dia/);
  });
});

test('suggest degrada sin git en vez de fallar', () => {
  inSandbox((root) => {
    writeNode(root, { id: 'A', edges: [] });
    const salida = cmdSuggest([], {}).output;
    assert.match(salida, /hace falta git/);
    assert.match(salida, /POR REVISAR/, 'la otra mitad sale igual: solo necesita el indice');
  });
});

// --- Detectores y scan -----------------------------------------------------
//
// El paso intermedio entre "empiezas en cero" y "hace falta un parser". Un
// detector no entiende el lenguaje: reconoce una convencion que el equipo
// declara en un fichero versionado.

test('los globs cubren lo que aparece en un detector real', () => {
  const casa = (glob, file) => globMatcher([glob])(file);
  assert.equal(casa('**/*Page.xaml.cs', 'src/Ui/DetallePage.xaml.cs'), true);
  assert.equal(casa('**/*Page.xaml.cs', 'DetallePage.xaml.cs'), true, '**/ tambien casa con ninguna carpeta');
  assert.equal(casa('**/*Page.xaml.cs', 'src/Ui/Detalle.cs'), false);
  assert.equal(casa('src/**/*.cs', 'otro/A.cs'), false, 'el prefijo se respeta');
  assert.equal(casa('*.controller.ts', 'a/user.controller.ts'), false, '* no cruza separadores');
  assert.equal(casa('**/*.{cs,vb}', 'src/A.vb'), true);
  assert.equal(casa('**/*.cs', 'src/A.CS'), false, 'sensible a mayusculas, como el disco en Linux');
});

test('deriveId quita el sufijo mas largo aunque se declaren en otro orden', () => {
  // Con [".cs", ".xaml.cs"] al reves quedaria "DetallePage.xaml".
  const id = deriveId('src/Ui/DetallePage.xaml.cs', {
    strip_prefix: ['src/'],
    strip_suffix: ['.cs', '.xaml.cs'],
  });
  assert.equal(id, 'Ui.DetallePage');
});

test('deriveId no produce ids que el esquema vaya a rechazar', () => {
  // Una ruta que empieza por digito daria un id invalido, y el fallo saldria
  // mucho despues, cuando ya no hay contexto para explicarlo.
  const id = deriveId('2024/informe.cs', {});
  assert.equal(id, '_2024.informe');
  assert.deepEqual(validateNode({ id }), []);
});

test('scan propone solo lo que no tiene hecho, y dice de cuantos', () => {
  inSandbox((root) => {
    fs.mkdirSync(path.join(root, 'src', 'Ui'), { recursive: true });
    for (const n of ['Detalle', 'Lista']) {
      fs.writeFileSync(path.join(root, 'src', 'Ui', `${n}Page.xaml.cs`), 'class X : ContentPage {}\n');
    }
    fs.writeFileSync(path.join(root, 'src', 'Ui', 'NoEsPagina.cs'), 'class Y {}\n');
    writeNode(root, { id: 'Ui.DetallePage', file: 'src/Ui/DetallePage.xaml.cs', edges: [] });

    const salida = cmdScan([], {}).output;
    assert.match(salida, /maui-page.*1 sin hecho de 2 que casan/);
    assert.match(salida, /Ui\.ListaPage/);
    assert.ok(!salida.includes('NoEsPagina'), 'el glob no casa con ese');
  });
});

test('scan --apply exige un kind concreto', () => {
  // Registrar de golpe los candidatos de todas las reglas llenaria el indice de
  // conjeturas que nadie ha mirado.
  inSandbox((root) => {
    const resultado = cmdScan([], { apply: true });
    assert.equal(resultado.code, 1);
    assert.match(resultado.output, /hace falta decir que kind/);
  });
});

test('scan --apply escribe candidatos sin verificar, con las aristas del kind', () => {
  inSandbox((root) => {
    fs.mkdirSync(path.join(root, 'src', 'Ui'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'Ui', 'ListaPage.xaml.cs'), 'class X : ContentPage {}\n');
    cmdScan(['maui-page'], { apply: true });

    const node = readNode(root, 'Ui.ListaPage');
    assert.equal(node.kind, 'maui-page');
    assert.equal(node.verified, undefined, 'una conjetura no se sella');
    assert.ok(node.edges.length >= 4, 'las aristas implicitas del kind si se aplican');
    assert.ok(node.edges.every((e) => e.source === 'rule:dotnet-maui'));
  });
});

test('scan respeta el contenido exigido por el detector', () => {
  inSandbox((root) => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    // Casa con el glob pero no con `contains`: no es una pagina.
    fs.writeFileSync(path.join(root, 'src', 'FalsaPage.xaml.cs'), 'class X { }\n');
    assert.ok(!cmdScan([], {}).output.includes('FalsaPage'));
  });
});

// --- Adaptadores de manifiesto ---------------------------------------------
//
// El codigo que se ejecuta cada noche a las dos no contiene ni una pista de que
// algo lo ejecuta cada noche a las dos. Es una arista `schedules` en estado
// puro, y ya esta escrita en un fichero de texto.

test('looksLikeCron rechaza una frase de seis palabras', () => {
  // Sin esta comprobacion, cualquier linea suelta del fichero se convertia en
  // una tarea con un horario inventado.
  assert.equal(looksLikeCron(['*/5', '*', '*', '*', '*']), true);
  assert.equal(looksLikeCron(['0', '0', '1', '*', 'MON']), true);
  assert.equal(looksLikeCron(['esto', 'no', 'es', 'una', 'linea']), false);
});

test('describeSchedule traduce solo lo inequivoco', () => {
  // Una traduccion a medias de un horario es peor que no traducir: quien la lee
  // se fia y planifica sobre ella.
  assert.equal(describeSchedule('*/5 * * * *'), 'cada 5 minutos');
  assert.equal(describeSchedule('0 2 * * *'), 'todos los dias a las 02:00');
  assert.equal(describeSchedule('15 3 * * 1'), null, 'los lunes: no se arriesga');
  assert.equal(describeSchedule('0 0 1,15 * *'), null);
});

test('jobName se salta el interprete', () => {
  assert.equal(jobName('/usr/bin/dotnet /opt/erp/Facturacion.dll --nocturno'), 'Facturacion');
  assert.equal(jobName('/usr/bin/python3 /opt/erp/informes.py'), 'informes');
  assert.equal(jobName('/opt/scripts/limpieza.sh'), 'limpieza');
});

test('el crontab produce la arista en la direccion que responde "quien ejecuta esto"', () => {
  // Las entrantes se derivan al consultar, asi que el disparador tiene que ser
  // el origen para que `query Facturacion` conteste.
  const { nodes } = parseCrontab('0 2 * * * /usr/bin/dotnet /opt/erp/Facturacion.dll\n');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, 'cron.Facturacion');
  assert.equal(nodes[0].edges[0].to, 'Facturacion');
  assert.equal(nodes[0].edges[0].type, 'schedules');
  assert.equal(nodes[0].edges[0].confidence, 'unverified', 'el destino es una deduccion');
});

test('dos tareas del mismo ejecutable no se pisan', () => {
  const { nodes } = parseCrontab('0 2 * * * /app/F.dll --diario\n15 3 * * 1 /app/F.dll --semanal\n');
  assert.deepEqual(nodes.map((n) => n.id), ['cron.F', 'cron.F.2']);
});

test('el crontab ignora comentarios y variables de entorno', () => {
  const { nodes, problemas } = parseCrontab('# comentario\nPATH=/usr/bin\nMAILTO=a@b.c\n@daily /app/x.sh\n');
  assert.equal(nodes.length, 1);
  assert.deepEqual(problemas, []);
});

test('un .timer de systemd apunta a su .service por convencion', () => {
  const { nodes } = parseTimer('[Timer]\nOnCalendar=daily\n', 'backup');
  assert.equal(nodes[0].id, 'systemd.backup');
  assert.equal(nodes[0].edges[0].to, 'backup', 'x.timer dispara x.service');
});

test('un .timer sin horario se reporta en vez de inventarselo', () => {
  const { nodes, problemas } = parseTimer('[Unit]\nDescription=x\n', 'roto');
  assert.equal(nodes.length, 0);
  assert.equal(problemas.length, 1);
});

test('reimportar conserva lo que ha escrito una persona', () => {
  // Un importador que pisa el trabajo humano se ejecuta una vez y no se vuelve
  // a tocar, y entonces el hecho envejece igual que si no existiera.
  inSandbox((root) => {
    const crontab = path.join(root, 'crontab.txt');
    fs.writeFileSync(crontab, '0 2 * * * /app/Facturacion.dll\n');
    cmdImport(['cron', crontab], {});

    cmdLink(['cron.Facturacion', 'Erp.Core.Facturacion', 'calls'], { note: 'el punto de entrada real' });

    fs.writeFileSync(crontab, '0 5 * * * /app/Facturacion.dll\n');
    cmdImport(['cron', crontab], {});

    const node = readNode(root, 'cron.Facturacion');
    const humana = node.edges.find((e) => e.to === 'Erp.Core.Facturacion');
    assert.ok(humana, 'la arista escrita a mano sobrevive');
    assert.equal(humana.note, 'el punto de entrada real');
    const importada = node.edges.find((e) => e.source === 'import:cron');
    assert.match(importada.trigger, /05:00/, 'y el horario si se actualiza');
    assert.equal(node.edges.filter((e) => e.source === 'import:cron').length, 1, 'sin duplicar');
  });
});
