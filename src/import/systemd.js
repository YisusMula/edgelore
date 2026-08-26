/**
 * Adaptador de temporizadores de systemd.
 *
 * Mismo caso que crontab y la misma razon para existir: un `.timer` declara que
 * algo se ejecuta a diario, y el codigo que se ejecuta no contiene ni una pista
 * de ello. El formato es INI, se parsea sin dependencias, y el vinculo
 * timer -> service esta escrito explicitamente o se deduce del nombre, que es
 * la convencion que usa el propio systemd.
 */

/** Parseo minimo de INI: sections y clave=valor. Suficiente para un .timer. */
export function parseIni(text) {
  const out = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const linea = raw.trim();
    if (!linea || linea.startsWith('#') || linea.startsWith(';')) continue;
    const cabecera = /^\[(.+)\]$/.exec(linea);
    if (cabecera) {
      section = cabecera[1];
      out[section] ??= {};
      continue;
    }
    const igual = linea.indexOf('=');
    if (igual <= 0) continue;
    const clave = linea.slice(0, igual).trim();
    const valor = linea.slice(igual + 1).trim();
    out[section] ??= {};
    // systemd permite repetir una clave; se conservan todas porque un
    // temporizador con varios OnCalendar se dispara en todos ellos, y quedarse
    // con uno diria algo falso sobre cuando se ejecuta.
    if (out[section][clave] === undefined) out[section][clave] = valor;
    else out[section][clave] = `${out[section][clave]}, ${valor}`;
  }
  return out;
}

/**
 * Convierte un `.timer` en un hecho.
 *
 * `unitName` es el nombre del fichero sin extension: systemd lo necesita porque
 * la convencion por defecto -un `x.timer` dispara `x.service`- solo se puede
 * resolver conociendolo.
 */
export function parseTimer(text, unitName, { prefix = 'systemd' } = {}) {
  const ini = parseIni(text);
  const timer = ini.Timer ?? {};

  const cuando = timer.OnCalendar
    ?? (timer.OnBootSec ? `${timer.OnBootSec} despues de arrancar` : null)
    ?? (timer.OnUnitActiveSec ? `cada ${timer.OnUnitActiveSec} tras la ultima ejecucion` : null);

  if (!cuando) {
    return { nodes: [], problemas: [`${unitName}: no declara OnCalendar, OnBootSec ni OnUnitActiveSec`] };
  }

  // Unit= explicito, o la convencion de systemd: x.timer dispara x.service.
  const destinoBruto = timer.Unit ?? `${unitName}.service`;
  const destino = destinoBruto.replace(/\.service$/, '').replace(/[^\w.+-]/g, '_');
  const seguro = /^[A-Za-z_]/.test(destino) ? destino : `_${destino}`;
  const nombre = unitName.replace(/[^\w.+-]/g, '_');

  return {
    nodes: [
      {
        id: `${prefix}.${/^[A-Za-z_]/.test(nombre) ? nombre : `_${nombre}`}`,
        kind: 'scheduled-job',
        summary: `Temporizador de systemd: ${cuando}`,
        edges: [
          {
            to: seguro,
            type: 'schedules',
            confidence: 'unverified',
            source: 'import:systemd',
            trigger: `systemd lo activa: ${cuando}`,
            note: ini.Unit?.Description ? String(ini.Unit.Description) : undefined,
          },
        ],
      },
    ],
    problemas: [],
  };
}
