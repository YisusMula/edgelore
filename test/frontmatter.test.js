import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, stringifyYaml, parseFrontmatter, stringifyFrontmatter, YamlError } from '../src/frontmatter.js';

test('parsea escalares y respeta cadenas que parecen otra cosa', () => {
  const data = parseYaml(`
id: Erp.Ventas.PagoService
kind: class
date: 2026-08-19
version: 1.10
enabled: true
disabled: false
empty: null
`);
  assert.deepEqual(data, {
    id: 'Erp.Ventas.PagoService',
    kind: 'class',
    date: '2026-08-19',
    version: '1.10',
    enabled: true,
    disabled: false,
    empty: null,
  });
});

test('mantiene fechas y versiones como cadenas, no como numeros', () => {
  const data = parseYaml('date: 2026-08-19\nport: 8080\n');
  assert.equal(typeof data.date, 'string');
  assert.equal(typeof data.port, 'string');
});

test('parsea listas en linea y listas de bloque', () => {
  const data = parseYaml(`
tags: [erp, pagos]
areas:
  - ventas
  - contabilidad
`);
  assert.deepEqual(data.tags, ['erp', 'pagos']);
  assert.deepEqual(data.areas, ['ventas', 'contabilidad']);
});

test('parsea listas de mapas con claves multiples', () => {
  const data = parseYaml(`
edges:
  - to: Erp.Data.FacturaRepository
    type: calls
    confidence: certain
  - to: PagoService.OnStart
    type: lifecycle
    trigger: arranque del servicio
`);
  assert.equal(data.edges.length, 2);
  assert.deepEqual(data.edges[0], {
    to: 'Erp.Data.FacturaRepository',
    type: 'calls',
    confidence: 'certain',
  });
  assert.equal(data.edges[1].trigger, 'arranque del servicio');
});

test('parsea mapas anidados', () => {
  const data = parseYaml(`
verified:
  commit: a3f9c21
  date: 2026-08-19
`);
  assert.deepEqual(data.verified, { commit: 'a3f9c21', date: '2026-08-19' });
});

test('admite listas indentadas al mismo nivel que su clave', () => {
  const data = parseYaml(`
edges:
- to: A
  type: calls
- to: B
  type: reads
`);
  assert.equal(data.edges.length, 2);
  assert.equal(data.edges[1].to, 'B');
});

test('respeta los dos puntos dentro de valores entrecomillados', () => {
  const data = parseYaml('note: "se registra como ruta: detalle"\n');
  assert.equal(data.note, 'se registra como ruta: detalle');
});

test('ignora comentarios pero no las almohadillas dentro de cadenas', () => {
  const data = parseYaml('id: Foo   # comentario\nnote: "color #ff0000"\n');
  assert.equal(data.id, 'Foo');
  assert.equal(data.note, 'color #ff0000');
});

test('rechaza tabulaciones, claves duplicadas y mapas en linea', () => {
  assert.throws(() => parseYaml('id:\tFoo\n'), YamlError);
  assert.throws(() => parseYaml('id: A\nid: B\n'), YamlError);
  assert.throws(() => parseYaml('verified: {commit: a}\n'), YamlError);
});

test('el ciclo serializar/parsear conserva la estructura', () => {
  const original = {
    id: 'Erp.Ventas.PagoService',
    kind: 'class',
    tags: ['erp', 'pagos'],
    edges: [
      { to: 'Erp.Data.FacturaRepository', type: 'calls', note: 'incluye: dos puntos' },
      { to: 'PagoService.OnStart', type: 'lifecycle' },
    ],
    verified: { commit: 'a3f9c21', date: '2026-08-19' },
    vacio: [],
  };
  assert.deepEqual(parseYaml(stringifyYaml(original)), original);
});

test('la serializacion es estable entre llamadas', () => {
  const value = { id: 'A', edges: [{ to: 'B', type: 'calls' }] };
  assert.equal(stringifyYaml(value), stringifyYaml(value));
});

test('separa frontmatter y cuerpo markdown', () => {
  const { data, body } = parseFrontmatter('---\nid: Foo\n---\n\nNotas libres.\n');
  assert.equal(data.id, 'Foo');
  assert.equal(body, 'Notas libres.');
});

test('un hecho sin cuerpo sigue siendo valido', () => {
  const { data, body } = parseFrontmatter('---\nid: Foo\n---\n');
  assert.equal(data.id, 'Foo');
  assert.equal(body, '');
});

test('el frontmatter sobrevive al ciclo completo', () => {
  const text = stringifyFrontmatter({ id: 'Foo', edges: [{ to: 'Bar', type: 'calls' }] }, 'Una nota.');
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.edges[0].to, 'Bar');
  assert.equal(body, 'Una nota.');
});

test('un fichero sin delimitadores da un error claro', () => {
  assert.throws(() => parseFrontmatter('id: Foo\n'), YamlError);
});

test('soporta escalares de bloque plegados (>-)', () => {
  const data = parseYaml(`
trigger: >-
  el runtime lo invoca cada vez que la pagina
  se hace visible
type: lifecycle
`);
  assert.equal(data.trigger, 'el runtime lo invoca cada vez que la pagina se hace visible');
  assert.equal(data.type, 'lifecycle');
});

test('soporta escalares de bloque literales (|)', () => {
  const data = parseYaml('nota: |\n  primera\n  segunda\n');
  assert.equal(data.nota, 'primera\nsegunda\n');
});

test('un escalar de bloque conserva almohadillas y no las trata como comentario', () => {
  const data = parseYaml('nota: >-\n  color #ff0000 del tema\n');
  assert.equal(data.nota, 'color #ff0000 del tema');
});

test('admite escalares de bloque dentro de items de lista', () => {
  const data = parseYaml(`
edges:
  - member: OnAppearing
    trigger: >-
      lo invoca el runtime al hacerse
      visible la pagina
    type: lifecycle
  - member: OnStop
    type: lifecycle
`);
  assert.equal(data.edges.length, 2);
  assert.equal(data.edges[0].trigger, 'lo invoca el runtime al hacerse visible la pagina');
  assert.equal(data.edges[0].type, 'lifecycle');
  assert.equal(data.edges[1].member, 'OnStop');
});

test('no confunde un valor que contiene > con un bloque', () => {
  const data = parseYaml('note: "a > b"\ncmd: usa --flag > salida.txt\n');
  assert.equal(data.note, 'a > b');
  assert.equal(data.cmd, 'usa --flag > salida.txt');
});
