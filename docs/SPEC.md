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
verified:
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
| `verified` | no | `commit`, `date` y opcionalmente `by`. Base de `edgelore stale`. |

## Campos de una arista

| Campo | Obligatorio | Descripción |
|---|---|---|
| `to` | sí | Id del nodo destino. No hace falta que exista todavía. |
| `type` | sí | Del vocabulario de abajo. |
| `confidence` | sí (por defecto `unverified`) | `certain`, `likely` o `unverified`. |
| `source` | sí (por defecto `human`) | `human`, `rule:<id>` o `extractor:<id>`. |
| `trigger` | en `lifecycle` y `schedules` | Qué la dispara. |
| `at` | en `string-ref` (o `note`) | `fichero:línea` donde está el literal. |
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
dice cuánto se comprobó; `verified.commit` permite a `edgelore stale` detectar que el
código cambió después. Sin ambos campos el índice se pudre en silencio.

**La confianza decae al mostrarse, no en el fichero.** Nadie puede recalcular si
un hecho sigue siendo cierto sin mirarlo, así que Edgelore no degrada
`confidence` por su cuenta — sería inventarse una verdad. Lo que sí hace es
dejar de imprimir el sello a secas: pasados `--max-age` días (365 por defecto),
`query` añade `<- sin reverificar desde hace N meses` e `impact` resume cuántos
de los dependientes listados están en esa situación. Un nodo con aristas y sin
`verified` se marca `SIN VERIFICAR`. No se añade ningún campo: el dato ya
estaba en `verified.date`.

**El texto libre se acota al renderizar.** `summary` lo limita el esquema a 300
caracteres, pero `note`, `trigger`, `at` y el cuerpo del markdown (`notes`) no
tienen límite en disco — y no deben tenerlo, porque ahí es donde se explica lo
que costó descubrir. El límite está en la salida: 200 caracteres por campo
inline y 1.200 para el cuerpo, indicando siempre cuánto se ha recortado. Es
condición de que el índice ahorre: una consulta que devuelve 10 KB cuesta más
que la búsqueda que evita, y ese texto es además lo que el hook previo a la
edición inyecta sin que nadie lo pida. `--all` lo levanta todo.

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
