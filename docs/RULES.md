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

## Añadir un framework nuevo

Crea `.edgelore/rules/<id>.yaml` con la estructura de arriba y confírmalo al
repositorio. `edgelore kinds` lo recogerá en la siguiente ejecución; no hay nada que
registrar ni recompilar.

Como el formato de un hecho no depende de ningún parser, una regla puede
describir cualquier stack: Angular (`ngOnInit`), React (`useEffect`), Spring
(`@Scheduled`), Android (callbacks de ciclo de vida), o una convención interna
vuestra que ningún framework conoce.
