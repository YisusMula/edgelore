# Formato de un hecho

Un **hecho** describe un nodo y las aristas que salen de él. Vive en
`.edgelore/nodes/<id>.md`: frontmatter YAML para lo consultable, cuerpo Markdown
para el matiz que no cabe en un campo.

```markdown
---
id: Erp.Ui.DetallePage
kind: maui-page
file: src/Ui/DetallePage.xaml.cs
lang: csharp
summary: Detalle de factura; carga en OnAppearing, no en el constructor
tags: [ventas, ui]
edges:
  - to: Erp.Ui.DetallePage.OnAppearing
    type: lifecycle
    confidence: certain
    source: rule:dotnet-maui
    trigger: >-
      el runtime lo invoca cada vez que la página se hace visible,
      incluido al volver atrás desde otra página
  - to: Erp.Ventas.FacturaViewModel
    type: calls
    confidence: certain
    source: human
    at: src/Ui/DetallePage.xaml.cs:18
    anchor: _vm = new FacturaViewModel(Id);
verified:
  fingerprint: "sha256:9f2c1a4b8e6d3057"
  commit: a3f9c21
  date: 2026-08-19
  by: alguien@empresa.com
---

Cargar en OnAppearing y no en el constructor es deliberado: el ViewModel aún no
tiene el Id cuando se construye la página. Cambiarlo rompe la vuelta atrás.
```

## Campos del nodo

| Campo | Obligatorio | Descripción |
|---|---|---|
| `id` | sí | Identificador único y estable. Convención: nombre cualificado (`Erp.Ventas.PagoService`). |
| `kind` | no | Tipo de nodo. Activa las reglas del framework. `edgelore kinds` los lista. |
| `file` | no | Ruta **relativa a la raíz del repositorio**. Se valida que exista. |
| `lang` | no | Lenguaje, informativo. |
| `summary` | no | Una línea, máximo 300 caracteres. El detalle va en el cuerpo. |
| `tags` | no | Lista para agrupar por área funcional. |
| `edges` | no | Aristas salientes. |
| `verified` | no | Sello de comprobación. Solo `date` es obligatorio dentro. Base de `edgelore stale`. |

### El sello `verified`

| Subcampo | Obligatorio | Descripción |
|---|---|---|
| `date` | sí | Cuándo se comprobó. Alimenta el decaimiento de la confianza. |
| `fingerprint` | no | `sha256:` + 16 hex del contenido del fichero. **El mecanismo** con el que `stale` detecta que el código cambió. |
| `commit` | no | Commit de HEAD al sellar. Enriquecimiento: da algo que teclear (`git show`). |
| `by` | no | Quién lo comprobó. |

**La huella es el mecanismo; git solo enriquece.** Al principio era al revés y
eso abría dos agujeros. Fuera de un repositorio git no se sellaba nada, así que
`stale` no podía decir nada en SVN, Mercurial, Perforce o un árbol exportado sin
historia. Y dentro de git, `filesChangedSince` devuelve `null` cuando no
reconoce el commit del sello — lo que ocurre **en cuanto alguien hace squash al
mergear** — y ese `null` se interpretaba como «ante la duda, no marcar nada»:
los hechos verificados dejaban de comprobarse en silencio y `stale` respondía
«todos al día» porque no podía preguntar, no porque lo estuvieran.

La huella se calcula sobre el contenido **normalizado**: CRLF→LF y sin BOM. Sin
eso, un equipo mixto Windows/Linux vería todos los hechos caducados al cambiar
de máquina, porque `core.autocrlf=true` materializa el árbol con CRLF.

Son 16 caracteres hexadecimales y no los 64 porque aquí no hay un adversario
intentando colisionar un hash: hay un fichero que cambia o no cambia. 64 bits
sobran, y el resto solo haría más ruidoso cada diff.

Un nodo sin `file` (una tabla, una clave de configuración) no tiene contenido
que resumir: se sella igual con la fecha, porque «alguien afirmó esto el día
tal» sigue siendo información, aunque `stale` no pueda comprobarlo después.

## Campos de una arista

| Campo | Obligatorio | Descripción |
|---|---|---|
| `to` | sí | Id del nodo destino. No hace falta que exista todavía. |
| `type` | sí | Del vocabulario de abajo. |
| `confidence` | sí (por defecto `unverified`) | `certain`, `likely` o `unverified`. |
| `source` | sí (por defecto `human`) | `human`, `rule:<id>` o `extractor:<id>`. |
| `trigger` | en `lifecycle` y `schedules` | Qué la dispara. |
| `at` | en `string-ref` (o `note`) | `fichero:línea` donde está el literal. |
| `anchor` | no | Texto de esa línea. Permite reajustarla cuando se desplaza. Se captura solo. |
| `note` | no | Matiz breve. |

## Vocabulario de tipos

Es corto a propósito: un vocabulario amplio se usa de forma inconsistente entre
personas y deja de ser consultable.

| Tipo | Significado | ¿Lo encuentra grep? |
|---|---|---|
| `calls` | Llamada explícita, escrita en el código. | Sí |
| `implements` | Implementa una interfaz o hereda de un tipo. | Sí |
| `reads` | Lee estado: tabla, fichero, caché, propiedad compartida. | A veces |
| `writes` | Escribe estado. | A veces |
| `string-ref` | Referencia por literal: rutas, reflexión, DI por nombre. | **No** |
| `lifecycle` | Lo invoca el runtime o el framework. | **No** |
| `event` | Publica o consume un evento o mensaje. | **No** |
| `config` | Depende de una clave de configuración. | **No** |
| `schedules` | Lo dispara un temporizador o una tarea programada. | **No** |
| `affects` | Efecto observado que no encaja arriba. | **No** |

**Registra sobre todo las que grep no encuentra.** Un índice lleno de `calls`
explícitas es ruido que hay que mantener y que no ahorra nada.

## Dos decisiones que conviene entender

**Las aristas entrantes no se escriben nunca.** Se derivan al consultar. Si
`AppShell` referencia a `DetallePage`, eso se escribe **solo** en el fichero de
`AppShell`. Registrar una relación toca un fichero, no dos: es lo que evita los
conflictos de merge cuando dos personas trabajan a la vez.

**`confidence` y `verified` no son burocracia.** El riesgo real de un índice
curado no es quedarse corto, es **mentir**: un hecho que era cierto hace tres
meses se lee hoy con la misma confianza que uno recién comprobado. `confidence`
dice cuánto se comprobó; `verified.fingerprint` permite a `edgelore stale`
detectar que el código cambió después. Sin ambos campos el índice se pudre en
silencio.

**La confianza decae al mostrarse, no en el fichero.** Nadie puede recalcular si
un hecho sigue siendo cierto sin mirarlo, así que Edgelore no degrada
`confidence` por su cuenta — sería inventarse una verdad. Lo que sí hace es
dejar de imprimir el sello a secas: pasados `--max-age` días (365 por defecto),
`query` añade `<- sin reverificar desde hace N meses` e `impact` resume cuántos
de los dependientes alcanzados están en esa situación, contados por nodo y no
por arista. Un nodo con aristas y sin `verified` se marca `SIN VERIFICAR`. No
se añade ningún campo: el dato ya estaba en `verified.date`.

Ambas marcas son accionables en cualquier repositorio: `edgelore verify` sella
con la huella del contenido y no necesita git.

**El texto libre se acota al renderizar.** `summary` lo limita el esquema a 300
caracteres, pero `note`, `trigger`, `at` y el cuerpo del markdown (`notes`) no
tienen límite en disco — y no deben tenerlo, porque ahí es donde se explica lo
que costó descubrir. El límite está en la salida: 200 caracteres por campo
inline y 1.200 para el cuerpo, indicando siempre cuánto se ha recortado. Es
condición de que el índice ahorre: una consulta que devuelve 10 KB cuesta más
que la búsqueda que evita, y ese texto es además lo que el hook previo a la
edición inyecta sin que nadie lo pida. `--all` lo levanta todo.

### El ancla de una referencia

`at: src/AppShell.xaml.cs:42` deja de ser cierto en cuanto alguien añade una
línea más arriba — y `at` es el campo de las aristas `string-ref`, las de más
valor del índice. **El dato más valioso era el más frágil, y fallaba en
silencio**: hasta que existió el ancla, nada comprobaba nunca que la línea 42
fuera la correcta. No es que se desincronizara; es que jamás se verificó.

El ancla guarda el texto de esa línea, normalizado (espacios colapsados, para
que reindentar no cuente). Al comprobarla hay tres desenlaces:

| Situación | Significado |
|---|---|
| La línea sigue casando | Todo bien. |
| El ancla está en **otra línea** | Desplazamiento. `edgelore relocate --apply` reescribe el `at`. |
| El ancla **no aparece** | La referencia está rota de verdad: hay que mirarla. |

Ése es el efecto que importa: convierte el desplazamiento de líneas —constante
y sin significado— en cambio de contenido —raro y significativo—. Sin esa
distinción, cualquier aviso basado en `at` sería ruido continuo, y un aviso que
da guerra deja de leerse.

**El ancla se captura sola** al usar `edgelore link --at`. Si hubiera que
escribirla a mano no la escribiría nadie, y una función que depende de que
alguien se acuerde de usarla es una función que no existe. `--anchor` está para
cuando la línea no es buen identificador (una llave suelta) o cuando se registra
sin tener el fichero delante.

**Nada de esto se ejecuta al consultar.** Abrir ficheros fuente en `query`,
`impact` o el hook cambiaría el modelo de coste de la herramienta —hoy una
consulta solo toca `.edgelore/`— y ralentizaría el camino que se recorre en cada
edición. Se comprueba en `relocate` y `validate`, donde alguien está mirando el
estado del índice a propósito.

### Nunca un secreto en un hecho

`edgelore add` y `edgelore link` **se niegan a escribir** si detectan una cadena
de conexión con contraseña, una clave de AWS, un token de GitHub o Slack, un JWT
o una clave privada en el texto del hecho. `validate` rompe el build por ello
**sin necesidad de `--strict`**, a diferencia del resto de categorías
informativas.

El motivo del trato distinto: el desgaste normal —ficheros movidos, hechos sin
reverificar— se arregla solo cuando alguien pasa por ahí. Un secreto no. Es la
única clase de fallo que **empeora cuanto más tarde se detecta** (una vez
commiteado ya no se borra del historial: hay que rotar la credencial) y la única
cuyo coste lo paga alguien distinto de quien la cometió.

Cada patrón exige **clave más valor**, nunca una palabra suelta. `Erp.Config.ApiKey`
como id de un nodo `config-key` es el uso previsto de la herramienta, y «la clave
vive en appsettings» es una nota legítima; lo que no lo es nunca es
`Password=loquesea`. Medido contra los 36 ficheros de este repositorio: cero
falsos positivos. `--force` existe para el que no hayamos previsto.

Los mensajes **nunca repiten lo encontrado**, solo su tipo: acaban en la
terminal, en el log de CI y probablemente en un ticket, y repetir el valor
multiplicaría la fuga en vez de contenerla.

### Lo que el hook inyecta es dato, no instrucción

Cualquier herramienta que meta contenido del repositorio en el contexto de un
agente es superficie de inyección, y resolverlo es responsabilidad de la
herramienta, no de la disciplina de cada equipo.

Aquí el riesgo es concreto y asimétrico: un `.edgelore/nodes/*.md` **parece
documentación y se revisa como documentación**, no como código — pero el hook lo
inyecta solo antes de la siguiente edición, sin que nadie lo pida. En un
repositorio público con contribuciones externas, esa diferencia entre cómo se
revisa y cómo se ejecuta es el vector.

Por eso todo lo que emite el hook va envuelto en `<edgelore-datos>` con un
preámbulo explícito. Es corto a propósito —61 tokens fijos por edición— y dice
lo mínimo: de dónde viene, que no son órdenes, y qué hacer si lo parecen.

## Reglas de identificación

- Un id casa con `^[A-Za-z_][\w.+-]*(/[\w.+-]+)*$` y no pasa de 200 caracteres.
- Los miembros se nombran `Tipo.Miembro` (`Erp.Ui.DetallePage.OnAppearing`). Es
  lo que permite preguntar «¿quién ejecuta OnAppearing?» y obtener respuesta.
- Nodos que no son código (tablas, claves de configuración, disparadores
  externos) usan el mismo espacio de ids. Es deliberado: la cadena interesante
  suele cruzar esa frontera.

## Edición

Usa `edgelore add` y `edgelore link` en vez de editar los ficheros a mano. El CLI valida
el esquema y normaliza el orden de las claves y de las aristas, que es lo que
mantiene los diffs limpios. Editar a mano funciona, pero `edgelore validate` es
entonces tu única red.
