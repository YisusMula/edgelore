import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadIndex, writeNode, readNode, findStoreRoot, incomingEdges, danglingIds } from '../src/store.js';
import { neighbourhood, search, path as findPath, stats, isHiddenEdge, impact, renderImpact } from '../src/query.js';
import { normalizeNode, validateNode, idToFilename } from '../src/model.js';
import { loadRules, kindCatalog, implicitEdgesFor } from '../src/rules.js';
import { buildNotice, buildImpactNotice, extractPaths } from '../src/commands/hook.js';
import { parseEdgeFlag, cmdAdd } from '../src/commands/write.js';
import { cmdInit, cmdUninstall, cmdRules, detectRuleSets } from '../src/commands/init.js';
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
