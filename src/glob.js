/**
 * Globs de ruta a expresion regular, sin dependencias.
 *
 * Se usa para los detectores de las reglas (`**\/*Page.xaml.cs`). Traer una
 * libreria de globbing por esto costaria mas de lo que resuelve: aqui hacen
 * falta cuatro construcciones, no el estandar entero, y este binario se ejecuta
 * en cada hook de edicion.
 *
 * Soportado, que es lo que aparece en un detector real:
 *   **\/   cualquier profundidad, incluida ninguna
 *   **     cualquier cosa, cruzando separadores
 *   *      cualquier cosa dentro de UN segmento
 *   ?      un caracter dentro de un segmento
 *   {a,b}  alternativa
 *
 * Las rutas se comparan siempre con / como separador: quien llama normaliza
 * antes, de modo que un mismo detector vale en Windows y en Linux.
 */

const ESPECIALES = /[.+^${}()|[\]\\]/g;

export function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];

    if (c === '*') {
      // `**/` come tambien el separador, para que `**/x` case con `x` a secas.
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }

    if (c === '?') {
      out += '[^/]';
      continue;
    }

    if (c === '{') {
      const cierre = pattern.indexOf('}', i);
      if (cierre !== -1) {
        const opciones = pattern
          .slice(i + 1, cierre)
          .split(',')
          .map((opcion) => opcion.replace(ESPECIALES, '\\$&').replace(/\*/g, '[^/]*'));
        out += `(?:${opciones.join('|')})`;
        i = cierre;
        continue;
      }
    }

    out += c.replace(ESPECIALES, '\\$&');
  }
  // Sin banderas de mayusculas/minusculas: las rutas de un repositorio son
  // sensibles a ellas en Linux, y un detector que casara de otra forma segun la
  // maquina daria resultados distintos a cada persona del equipo.
  return new RegExp(`^${out}$`);
}

/** Compila una lista de globs a un predicado. Sin globs, no casa nada. */
export function globMatcher(patterns) {
  const list = (Array.isArray(patterns) ? patterns : [patterns]).filter(Boolean);
  if (!list.length) return () => false;
  const regexes = list.map((pattern) => globToRegExp(String(pattern)));
  return (file) => regexes.some((regex) => regex.test(file));
}
