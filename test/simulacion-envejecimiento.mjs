/**
 * Simulacion de uso intensivo prolongado sobre el CLI real.
 *
 * No es una prueba automatica: es un banco de ensayo que se ejecuta a mano
 *   node test/simulacion-envejecimiento.mjs /tmp/repo 120
 * para ver como envejece el indice. Descubrio dos fallos de diseno que ninguna
 * prueba unitaria podia ver: que `validate` dejaba el CI en rojo permanente por
 * desgaste normal, y que los miembros generados por reglas ahogaban la lista de
 * ids sospechosos.
 *
 * Modela ~6 meses de trabajo de un equipo pequeno en un producto con libreria,
 * proyecto base y verticales. No mide solo velocidad: mide si el indice se
 * PUDRE mas rapido de lo que crece, que es el riesgo real de un indice curado.
 *
 * Se modelan a proposito los comportamientos que degradan:
 *   - el entusiasmo decae: se registran menos hechos con el tiempo
 *   - casi nadie vuelve a verificar lo que registro
 *   - en los refactors, a veces se usa `edgelore rename` y a veces se renombra
 *     la clase a secas y el indice se queda con el id viejo
 *   - se borran ficheros sin tocar el indice
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.argv[2];
import { fileURLToPath } from 'node:url';
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'edgelore.js');
const DIAS = Number(process.argv[3] ?? 120);

// Semilla fija: la simulacion tiene que ser reproducible para poder comparar.
let semilla = 12345;
const rnd = () => ((semilla = (semilla * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const elegir = (lista) => lista[Math.floor(rnd() * lista.length)];

const sh = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (error) {
    return { error: true, salida: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};
const git = (...args) => sh('git', args);
const el = (...args) => sh(process.execPath, [BIN, ...args]);

const cronometrar = (fn) => {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
};

// --- repositorio inicial -----------------------------------------------------
fs.rmSync(REPO, { recursive: true, force: true });
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
git('init', '-q');
git('config', 'user.email', 'equipo@ejemplo.com');
git('config', 'user.name', 'Equipo');

const MODULOS = ['Ventas', 'Compras', 'Almacen'];
const clases = [];
for (const m of MODULOS) {
  fs.mkdirSync(path.join(REPO, 'src', m), { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    const rel = `src/${m}/Pagina${i}.xaml.cs`;
    fs.writeFileSync(path.join(REPO, rel), `public partial class Pagina${i} : PageBase { }\n`);
    clases.push({ id: `Erp.${m}.Pagina${i}`, file: rel, registrado: false, vivo: true });
  }
}
fs.writeFileSync(path.join(REPO, 'src', 'PageBase.cs'), 'public class PageBase { }\n');
clases.push({ id: 'Base.Ui.PageBase', file: 'src/PageBase.cs', registrado: false, vivo: true });
git('add', '-A');
git('commit', '-qm', 'inicial');

el('init', '--rules', 'dotnet-maui,dotnet-core');
git('add', '-A');
git('commit', '-qm', 'instala edgelore');

// --- la jornada --------------------------------------------------------------
const historia = [];
let consultas = 0;
let msConsultas = 0;
let renombradosBien = 0;
let renombradosMal = 0;
let ficherosBorrados = 0;

for (let dia = 1; dia <= DIAS; dia += 1) {
  // 1. Se toca codigo (lo que hace que los hechos caduquen).
  for (let i = 0; i < 1 + Math.floor(rnd() * 3); i += 1) {
    const c = elegir(clases.filter((x) => x.vivo));
    if (!c) continue;
    fs.appendFileSync(path.join(REPO, c.file), `    // cambio dia ${dia}\n`);
  }

  // 2. Se registran hechos, con entusiasmo decayente: mucho al principio,
  //    poco a los meses. Es lo que pasa de verdad.
  const ganas = Math.max(0.08, 0.9 - dia / 140);
  if (rnd() < ganas) {
    const c = elegir(clases.filter((x) => x.vivo && !x.registrado));
    if (c) {
      el('add', c.id, '--file', c.file, '--kind', 'maui-page');
      c.registrado = true;
      const otro = elegir(clases.filter((x) => x.registrado && x.id !== c.id));
      if (otro) el('link', c.id, otro.id, 'calls');
    }
  }

  // 3. Consultas: lo que se hace muchas veces al dia.
  for (let i = 0; i < 3; i += 1) {
    const c = elegir(clases.filter((x) => x.registrado));
    if (!c) break;
    consultas += 1;
    msConsultas += cronometrar(() => el(rnd() < 0.5 ? 'query' : 'impact', c.id));
  }

  // 4. Refactors. La mitad de las veces se renombra bien; la otra mitad alguien
  //    renombra la clase y no toca el indice, que es el caso que lo pudre.
  if (rnd() < 0.12) {
    const c = elegir(clases.filter((x) => x.registrado && x.vivo));
    if (c) {
      const nuevo = `${c.id}V2`;
      if (rnd() < 0.5) {
        el('rename', c.id, nuevo);
        c.id = nuevo;
        renombradosBien += 1;
      } else {
        renombradosMal += 1;   // el indice se queda con el id viejo
      }
    }
  }

  // 5. De vez en cuando se borra un fichero sin avisar al indice.
  if (rnd() < 0.05) {
    const c = elegir(clases.filter((x) => x.vivo && x.registrado));
    if (c) {
      fs.rmSync(path.join(REPO, c.file), { force: true });
      c.vivo = false;
      ficherosBorrados += 1;
    }
  }

  // 6. Casi nadie vuelve a verificar lo que registro.
  if (rnd() < 0.1) {
    const c = elegir(clases.filter((x) => x.registrado && x.vivo));
    if (c) el('verify', c.id);
  }

  git('add', '-A');
  git('commit', '-qm', `dia ${dia}`);

  if (dia % 20 === 0 || dia === DIAS) {
    const st = typeof el('stats') === 'string' ? el('stats') : '';
    const nodos = Number(/nodos:\s+(\d+)/.exec(st)?.[1] ?? 0);
    const aristas = Number(/aristas:\s+(\d+)/.exec(st)?.[1] ?? 0);
    // Los miembros que generan las reglas no son podredumbre; los sospechosos si.
    const sospechosos = Number(/SIN DECLARAR y sin regla que los genere \((\d+)\)/.exec(st)?.[1] ?? 0);

    const val = el('validate');
    const salidaVal = typeof val === 'string' ? val : val.salida;
    const problemas = Number(/^(\d+) hecho\(s\) apuntan a ficheros/m.exec(salidaVal)?.[1] ?? 0);
    const esquema = Number(/^(\d+) error\(es\) de esquema/m.exec(salidaVal)?.[1] ?? 0);

    const stl = el('stale');
    const salidaStale = typeof stl === 'string' ? stl : stl.salida;
    const caducados = Number(/^(\d+) hecho\(s\) por revisar/m.exec(salidaStale)?.[1] ?? 0);
    const sinVerificar = Number(/(\d+) hecho\(s\) sin verificar/.exec(salidaStale)?.[1] ?? 0);

    const msQuery = cronometrar(() => el('query', elegir(clases.filter((x) => x.registrado)).id));

    historia.push({ dia, nodos, aristas, sospechosos, esquema, problemas, caducados, sinVerificar, msQuery });
  }
}

// --- informe -----------------------------------------------------------------
console.log(`\nSIMULACION: ${DIAS} dias de trabajo\n`);
console.log('  dia  nodos aristas  sospech  esquema  mienten  caducados   query');
for (const h of historia) {
  console.log(
    `  ${String(h.dia).padStart(3)}  ${String(h.nodos).padStart(5)} ${String(h.aristas).padStart(7)}`
    + `  ${String(h.sospechosos).padStart(7)}  ${String(h.esquema).padStart(7)}`
    + `  ${String(h.problemas).padStart(7)}  ${String(h.caducados).padStart(9)}`
    + `  ${String(Math.round(h.msQuery)).padStart(4)}ms`,
  );
}

const ultimo = historia[historia.length - 1];
const utiles = ultimo.nodos - ultimo.problemas;
console.log(`\n  consultas ejecutadas: ${consultas}, media ${(msConsultas / consultas).toFixed(0)} ms`);
console.log(`  refactors con rename: ${renombradosBien}   sin avisar al indice: ${renombradosMal}`);
console.log(`  ficheros borrados sin tocar el indice: ${ficherosBorrados}`);
console.log(`\n  hechos que MIENTEN (fichero inexistente): ${ultimo.problemas} de ${ultimo.nodos}`
  + ` (${((ultimo.problemas / ultimo.nodos) * 100).toFixed(0)}%)`);
console.log(`  hechos sin verificar desde que se escribieron: ${ultimo.sinVerificar}`);
console.log(`  hechos fiables: ${utiles}`);

const git1 = sh('git', ['log', '--oneline']);
console.log(`  commits: ${(typeof git1 === 'string' ? git1 : '').trim().split('\n').length}`);
const du = sh('du', ['-sh', '.edgelore']);
console.log(`  tamano del indice en disco: ${(typeof du === 'string' ? du : '').trim()}`);
