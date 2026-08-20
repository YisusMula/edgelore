import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadIndex, writeNode, readNode, findStoreRoot, incomingEdges, danglingIds } from '../src/store.js';
import { neighbourhood, search, path as findPath, stats, isHiddenEdge } from '../src/query.js';
import { normalizeNode, validateNode, idToFilename } from '../src/model.js';
import { loadRules, kindCatalog, implicitEdgesFor } from '../src/rules.js';
import { buildNotice, extractPaths } from '../src/commands/hook.js';
import { parseEdgeFlag, cmdAdd } from '../src/commands/write.js';
import { cmdInit } from '../src/commands/init.js';
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
