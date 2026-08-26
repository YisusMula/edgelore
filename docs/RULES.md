# Escribir reglas de framework

Una regla declara **una vez** lo que un framework hace por su cuenta, y esa
declaración vale para todos los nodos de ese tipo en el proyecto. Es lo que hace
que el índice escale: sin reglas, alguien tendría que escribir a mano la arista
de `OnAppearing` en las cuarenta páginas de la aplicación.

Las reglas viven en `.edgelore/rules/*.yaml` y se versionan con el repositorio.

## Estructura

```yaml
id: dotnet-maui
name: .NET MAUI

kinds:
  maui-page:
    label: Página (ContentPage / Shell page)
    implicit_edges:
      - member: OnAppearing
        type: lifecycle
        confidence: certain
        trigger: >-
          el runtime lo invoca cada vez que la página se hace visible,
          incluido al volver atrás desde otra página
    checklist:
      - "¿Se registra en Routing.RegisterRoute? Añade string-ref desde AppShell."
      - "¿Con qué ruta se navega hasta aquí (GoToAsync)?"
```

Una regla aporta dos cosas distintas, y conviene no confundirlas:

**`implicit_edges`** son aristas que se generan solas al declarar el `kind`. Son
para lo que el framework hace **siempre igual**, sin excepciones: si un tipo es
una `ContentPage` de MAUI, su `OnAppearing` lo invoca el runtime. Punto.

**`checklist`** son las preguntas que ninguna regla puede responder porque
dependen del caso concreto: con qué literal se registra *esta* página, qué
ViewModel usa, qué hace en `OnAppearing`. Se muestran al registrar un nodo de ese
kind — son un recordatorio, no una automatización.

## Campos de `implicit_edges`

| Campo | Descripción |
|---|---|
| `member` | Genera la arista hacia `<idDelNodo>.<member>`. Para miembros que invoca el runtime. |
| `to` | Alternativa a `member`: arista hacia un id fijo, no derivado del nodo. |
| `type` | Tipo de arista. Por defecto `lifecycle`. |
| `confidence` | Por defecto `certain`. Usa `likely` si el framework tiene excepciones. |
| `trigger` | **Obligatorio** en `lifecycle` y `schedules`. |
| `note` | Matiz opcional. |

Las aristas generadas se marcan con `source: rule:<id>`, de modo que siempre se
puede distinguir lo que declaró una persona de lo que puso una regla.

## Cómo escribir una regla útil

**Declara solo lo invariable.** Si el framework lo hace a veces, es `checklist`,
no `implicit_edges`. Una arista automática equivocada se propaga a todo el
proyecto de golpe.

**El `trigger` es lo que da valor, no la arista.** «El runtime lo invoca» no
sirve de nada. «El runtime lo invoca **cada vez** que la página se hace visible,
incluido al volver atrás» resuelve una clase entera de bugs. Escribe el trigger
pensando en quien lo lea dentro de seis meses sin contexto.

**La checklist debe apuntar a lo que se pierde.** No preguntes lo que se ve
leyendo el fichero; pregunta por el literal de la ruta, por el orden de arranque,
por qué pasa si falta la configuración.

## Cómo llegan las reglas a tu repositorio

`edgelore init` **detecta el stack** leyendo los ficheros de proyecto
(`.csproj`, `.sln`, `.props`…) hasta tres niveles de profundidad, saltándose
`obj/`, `bin/` y `node_modules/`. Instala solo lo que reconoce: un proyecto MAUI
con Entity Framework recibe `dotnet-core`, `dotnet-maui` y `dotnet-data`, pero no
`dotnet-winservice`.

Si no reconoce el stack no instala ninguna regla y lo dice. Edgelore funciona
igual sin ellas — solo dejan de generarse solas las aristas de ciclo de vida.

Para ampliar después, `edgelore rules add <nombre>` **nunca sobreescribe** una
regla existente, que puede llevar semanas de ajustes del equipo. Ésa es la
diferencia con `init --force`, que sí las reinstala.

## Reglas incluidas

| Fichero | Cubre |
|---|---|
| `dotnet-core` | DI, `IHostedService`, configuración, eventos y mensajes. |
| `dotnet-maui` | Páginas, ViewModels, rutas del Shell, vistas XAML, handlers. |
| `dotnet-winservice` | Servicios de Windows, trabajos periódicos, disparadores externos. |
| `dotnet-data` | Tablas, procedimientos almacenados, entidades y migraciones de EF. |

## Detectores: `detect`

Una regla puede además declarar **cómo se reconocen** los nodos de un `kind`.
Es lo que permite que `edgelore scan` proponga candidatos en vez de empezar a
mano por tres mil ficheros:

```yaml
kinds:
  maui-page:
    label: Pagina (ContentPage / Shell page)
    detect:
      files: ["**/*Page.xaml.cs"]
      contains: ["ContentPage|ShellContent"]
      id:
        strip_prefix: ["src/"]
        strip_suffix: [".xaml.cs", ".cs"]
    implicit_edges:
      # ...
```

| Campo | Qué hace |
|---|---|
| `files` | Globs de ruta. Soporta `**/`, `*`, `?` y `{a,b}`. Sensible a mayúsculas. |
| `contains` | Expresiones regulares que el contenido debe cumplir **todas**. Opcional. |
| `id.strip_prefix` | Prefijos de ruta que sobran (`src/`). |
| `id.strip_suffix` | Extensiones a quitar. Gana la más larga, sea cual sea el orden. |
| `id.prefix` | Se antepone al id derivado (`Erp.`). |

**Esto no rompe la promesa de no parsear.** Una expresión regular no sabe qué es
una clase; sabe que en este equipo las páginas se llaman así. Lo declara el
equipo, se versiona con el repo, y generaliza sin esfuerzo a `*.controller.ts`,
`@Scheduled`, `models.py` o `func Test`.

**Lo que produce son candidatos, no hechos comprobados.** `scan --apply` los
escribe sin sellar y con las aristas implícitas del `kind`. Que un fichero case
con un glob es una conjetura razonable sobre dónde mirar; no es una afirmación
sobre el código.

Dos cosas a vigilar al escribir un detector:

- **Los ids derivados.** `Erp.Ui.DetallePage` no se puede adivinar desde
  `src/Ui/DetallePage.xaml.cs` sin saber que `src/` sobra. `scan` los imprime
  siempre para que se revisen antes de aplicar.
- **`detect` solo donde la convención es fiable.** Las reglas incluidas lo
  declaran en `maui-page`, `maui-viewmodel`, `hosted-service` y `ef-migration`,
  y deliberadamente **no** en `db-table`, `config-key` o `service`: ahí no hay
  convención de nombres que aguante, y un detector que se equivoca la mitad de
  las veces llena el índice de basura que alguien tendrá que limpiar.

## Añadir un framework nuevo

Crea `.edgelore/rules/<id>.yaml` con la estructura de arriba y confírmalo al
repositorio. `edgelore kinds` lo recogerá en la siguiente ejecución; no hay nada que
registrar ni recompilar.

Como el formato de un hecho no depende de ningún parser, una regla puede
describir cualquier stack: Angular (`ngOnInit`), React (`useEffect`), Spring
(`@Scheduled`), Android (callbacks de ciclo de vida), o una convención interna
vuestra que ningún framework conoce.
