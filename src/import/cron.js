/**
 * Adaptador de crontab.
 *
 * Buena parte del cableado oculto de un sistema ya esta declarado, estructurado
 * y FUERA del codigo. Una tarea programada es el caso extremo: el codigo que se
 * ejecuta cada noche a las dos no contiene ni una pista de que algo lo ejecuta
 * cada noche a las dos. Es una arista `schedules` en estado puro, invisible a
 * cualquier grep, y esta escrita en un fichero de texto que se parsea en
 * cincuenta lineas.
 *
 * Se empieza por aqui y no por OpenAPI a proposito: crontab es linea a linea y
 * no necesita un parser de YAML completo, que el subconjunto estricto de este
 * proyecto no puede ser.
 */

/** Atajos que reconoce cron, con su equivalente en palabras. */
const ATAJOS = {
  '@yearly': { expr: '0 0 1 1 *', texto: 'una vez al ano, el 1 de enero' },
  '@annually': { expr: '0 0 1 1 *', texto: 'una vez al ano, el 1 de enero' },
  '@monthly': { expr: '0 0 1 * *', texto: 'el dia 1 de cada mes' },
  '@weekly': { expr: '0 0 * * 0', texto: 'cada domingo' },
  '@daily': { expr: '0 0 * * *', texto: 'todos los dias a medianoche' },
  '@midnight': { expr: '0 0 * * *', texto: 'todos los dias a medianoche' },
  '@hourly': { expr: '0 * * * *', texto: 'cada hora' },
  '@reboot': { expr: '@reboot', texto: 'al arrancar la maquina' },
};

/**
 * Traduce la expresion a palabras SOLO cuando no hay ambiguedad posible.
 *
 * Una traduccion a medias de un horario es peor que no traducir: quien lo lee
 * se fia y planifica sobre ella. Ante cualquier forma que no sea de las
 * evidentes se devuelve null y se muestra la expresion cruda, que al menos es
 * exacta.
 */
export function describeSchedule(expr) {
  const partes = expr.trim().split(/\s+/);
  if (partes.length !== 5) return null;
  const [min, hora, dia, mes, semana] = partes;
  const todos = (v) => v === '*';

  if (todos(dia) && todos(mes) && todos(semana)) {
    const cadaN = /^\*\/(\d+)$/.exec(min);
    if (cadaN && todos(hora)) return `cada ${cadaN[1]} minutos`;
    const cadaNHoras = /^\*\/(\d+)$/.exec(hora);
    if (/^\d+$/.test(min) && cadaNHoras) return `cada ${cadaNHoras[1]} horas, en el minuto ${Number(min)}`;
    if (/^\d+$/.test(min) && todos(hora)) return `cada hora, en el minuto ${Number(min)}`;
    if (/^\d+$/.test(min) && /^\d+$/.test(hora)) {
      return `todos los dias a las ${String(hora).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    }
  }
  return null;
}

/**
 * Un campo de horario admite digitos, `*`, rangos, listas y pasos; los dos
 * ultimos admiten ademas nombres de tres letras (MON, JAN).
 *
 * Comprobarlo no es quisquilloseria: sin esto, CUALQUIER linea de seis palabras
 * se importa como tarea. Una frase suelta en el fichero -o un comentario mal
 * escrito- se convertia en un hecho con un horario inventado, que es
 * exactamente la clase de mentira que este proyecto existe para evitar.
 */
const CAMPO_NUMERICO = /^[\d*]([\d*,\-/]*)$/;
const CAMPO_CON_NOMBRE = /^([\d*]([\d*,\-/]*)|[A-Za-z]{3}([,\-/][A-Za-z0-9]{1,3})*)$/;

export function looksLikeCron(partes) {
  if (partes.length !== 5) return false;
  return partes.slice(0, 3).every((campo) => CAMPO_NUMERICO.test(campo))
    && partes.slice(3).every((campo) => CAMPO_CON_NOMBRE.test(campo));
}

/** Nombre legible a partir del comando: el ejecutable o el script principal. */
export function jobName(command) {
  const tokens = command.trim().split(/\s+/);
  // Se salta el intérprete y sus opciones para quedarse con lo que de verdad se
  // ejecuta: `/usr/bin/dotnet /app/Facturacion.dll` es el trabajo "Facturacion".
  const interpretes = /^(\/\S+\/)?(dotnet|python3?|node|java|sh|bash|php|ruby|perl|pwsh|powershell)(\.exe)?$/i;
  let elegido = tokens[0] ?? '';
  for (const token of tokens) {
    if (token.startsWith('-')) continue;
    if (interpretes.test(token)) continue;
    elegido = token;
    break;
  }
  const base = elegido.split(/[\\/]/).pop() ?? elegido;
  const limpio = base.replace(/\.(dll|exe|sh|py|js|jar|ps1|rb|pl)$/i, '');
  const seguro = limpio.replace(/[^\w.+-]/g, '_');
  return /^[A-Za-z_]/.test(seguro) && seguro ? seguro : `job_${seguro || 'sin_nombre'}`;
}

/**
 * Convierte un crontab en hechos.
 *
 * El nodo es el DISPARADOR y la arista sale de el hacia lo que ejecuta. Esa
 * direccion no es arbitraria: las aristas entrantes se derivan al consultar, de
 * modo que asi `edgelore query Facturacion` responde "LLEGA DESDE: schedules
 * cron.Facturacion", que es justo la pregunta -quien ejecuta esto- que el
 * codigo no puede contestar.
 */
export function parseCrontab(text, { prefix = 'cron' } = {}) {
  const nodes = [];
  const problemas = [];
  const vistos = new Map();

  text.split(/\r?\n/).forEach((raw, indice) => {
    const linea = raw.trim();
    if (!linea || linea.startsWith('#')) return;
    // Asignaciones de entorno (PATH=..., MAILTO=...), no son tareas.
    if (/^[A-Z_][A-Z0-9_]*\s*=/.test(linea)) return;

    let expr;
    let resto;
    let texto = null;

    const atajo = /^(@\w+)\s+(.*)$/.exec(linea);
    if (atajo) {
      const conocido = ATAJOS[atajo[1].toLowerCase()];
      if (!conocido) {
        problemas.push(`linea ${indice + 1}: atajo desconocido "${atajo[1]}"`);
        return;
      }
      expr = conocido.expr;
      texto = conocido.texto;
      resto = atajo[2];
    } else {
      const campos = linea.split(/\s+/);
      if (campos.length < 6) {
        problemas.push(`linea ${indice + 1}: no tiene los cinco campos de horario mas un comando`);
        return;
      }
      if (!looksLikeCron(campos.slice(0, 5))) {
        problemas.push(`linea ${indice + 1}: los cinco primeros campos no son un horario de cron ("${campos.slice(0, 5).join(' ')}")`);
        return;
      }
      expr = campos.slice(0, 5).join(' ');
      resto = campos.slice(5).join(' ');
      texto = describeSchedule(expr);
    }

    // Un crontab de sistema (/etc/crontab) lleva el usuario antes del comando.
    const conUsuario = /^([a-z_][a-z0-9_-]*)\s+(\/\S+.*)$/i.exec(resto);
    const usuario = conUsuario ? conUsuario[1] : null;
    const command = conUsuario ? conUsuario[2] : resto;

    const nombre = jobName(command);
    // Dos tareas del mismo ejecutable con horarios distintos son dos hechos, no
    // uno que pisa al otro.
    const repeticion = (vistos.get(nombre) ?? 0) + 1;
    vistos.set(nombre, repeticion);
    const id = repeticion === 1 ? `${prefix}.${nombre}` : `${prefix}.${nombre}.${repeticion}`;

    const trigger = texto ? `${texto} (cron: ${expr})` : `cron: ${expr}`;
    nodes.push({
      id,
      kind: 'scheduled-job',
      summary: `Tarea programada: ${texto ?? expr}`,
      edges: [
        {
          to: nombre,
          type: 'schedules',
          confidence: 'unverified',
          source: 'import:cron',
          trigger,
          note: usuario ? `${command} (como ${usuario})` : command,
        },
      ],
    });
  });

  return { nodes, problemas };
}
