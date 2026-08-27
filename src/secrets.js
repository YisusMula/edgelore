/**
 * Deteccion de secretos en el texto de un hecho.
 *
 * Es la unica clase de fallo de este proyecto cuyo coste lo paga alguien
 * distinto de quien lo comete: quien escribe una cadena de conexion en la nota
 * de un hecho no se entera de nada, y el secreto queda en el historial del
 * repositorio, donde ya no se puede borrar. Y en un indice publico lo lee todo
 * el mundo. (OWASP LLM02, divulgacion de informacion sensible.)
 *
 * SE COMPRUEBA AL ESCRIBIR, no solo al validar. Avisar en `validate` llega
 * tarde: para entonces el secreto ya esta commiteado y rotarlo es la unica
 * salida. El unico momento util para pararlo es antes de que toque el disco.
 *
 * CADA PATRON EXIGE UN VALOR, no solo un nombre. Es la diferencia entre una
 * senal util y otro aviso que se aprende a ignorar: `Erp.Config.ApiKey` como id
 * de un nodo `config-key` es exactamente el uso previsto de la herramienta, y
 * "la clave vive en appsettings" es una nota legitima. Lo que no lo es nunca es
 * `Password=loquesea`. Por eso no hay ningun patron que case con una palabra
 * suelta: se busca clave MAS valor.
 */

const PATRONES = [
  {
    nombre: 'cadena de conexion con contrasena',
    regex: /\b(?:password|pwd)\s*=\s*[^\s;'"]{3,}/gi,
  },
  {
    nombre: 'clave de acceso de AWS',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    nombre: 'clave privada',
    regex: /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/g,
  },
  {
    // Los clasicos son gh?_ mas 36 caracteres, pero los de grano fino
    // (github_pat_) son mas largos y variables: se fija el minimo, no el
    // tamano exacto, para que un formato nuevo no pase inadvertido.
    nombre: 'token de GitHub',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
  {
    nombre: 'token de Slack',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    nombre: 'JSON Web Token',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./g,
  },
  {
    // Clave con valor asignado. Exige 16 caracteres o mas para no saltar con
    // `api_key = x` de un ejemplo, y excluye valores que son claramente
    // marcadores de posicion.
    nombre: 'clave de API o token con valor',
    regex: /\b(?:api[_-]?key|secret|token|access[_-]?key)\s*[:=]\s*['"]?([A-Za-z0-9_\-.]{16,})/gi,
    descartar: /^(?:x{3,}|\.{3,}|<|\{|\$|tu[_-]|your[_-]|placeholder|ejemplo|example|cambiame|changeme)/i,
  },
];

/**
 * Devuelve los nombres de los tipos de secreto encontrados, sin el valor.
 *
 * No se devuelve nunca lo encontrado: el mensaje de error acabaria en la
 * terminal, en el log de CI y probablemente en un ticket, multiplicando la
 * fuga en vez de contenerla. Con decir que hay y de que tipo basta para
 * arreglarlo.
 */
export function findSecrets(text) {
  const valor = String(text ?? '');
  if (!valor) return [];
  const encontrados = new Set();
  for (const patron of PATRONES) {
    patron.regex.lastIndex = 0;
    let match;
    while ((match = patron.regex.exec(valor)) !== null) {
      if (patron.descartar && match[1] && patron.descartar.test(match[1])) continue;
      encontrados.add(patron.nombre);
      break;
    }
  }
  return [...encontrados];
}

/** Todo el texto libre de un hecho, que es donde puede colarse un secreto. */
export function nodeText(node, notes = '') {
  const partes = [node.summary, notes];
  for (const edge of node.edges ?? []) partes.push(edge.note, edge.trigger, edge.at);
  return partes.filter(Boolean).join('\n');
}

/** Mensaje listo para mostrar, o null si no hay nada que decir. */
export function secretWarning(tipos, { id } = {}) {
  if (!tipos.length) return null;
  return [
    `Parece haber ${tipos.length === 1 ? 'un secreto' : 'secretos'} en el texto de ${id ?? 'este hecho'}: ${tipos.join(', ')}.`,
    'Un indice se versiona con el repositorio: una vez commiteado, el secreto queda',
    'en el historial y rotarlo es la unica salida. Quitalo de la nota y deja en su',
    'lugar donde esta la credencial, no cual es.',
  ].join('\n');
}
