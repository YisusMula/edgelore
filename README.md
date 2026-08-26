# Edgelore

**Índice curado de las referencias que tu código no declara.**

Un `OnAppearing` no lo llama nadie. Un servicio de Windows lo arranca el SCM.
Una página se resuelve desde el literal `"detalle"`. Un procedimiento almacenado
se invoca por su nombre en una cadena. Nada de eso aparece como una llamada en
ningún sitio, así que `grep NombreDeLaClase` no lo encuentra — y quien pregunta
«¿quién ejecuta esto?» se queda sin respuesta.

Edgelore es el sitio donde el equipo escribe esas conexiones, una vez, cuando las
descubre. Vive en `.edgelore/`, se versiona con git, y se consulta con una orden.

```
$ edgelore query Erp.Ui.DetallePage

Erp.Ui.DetallePage  [maui-page]
  archivo: src/Ui/DetallePage.xaml.cs
  Detalle de factura; carga en OnAppearing, no en el constructor
  verificado: 90b55fb (2026-08-19)

SALE HACIA (4):
  lifecycle   Erp.Ui.DetallePage.OnAppearing
              disparado por: el runtime lo invoca CADA VEZ que la página se hace
              visible, incluido al volver atrás desde otra página

LLEGA DESDE (1):
  string-ref  AppShell
              en src/AppShell.xaml.cs:42 | registrada como ruta "detalle"
```

Eso son unos 300 tokens. Reconstruirlo a mano son diez búsquedas fallidas,
tres ficheros leídos enteros y, con frecuencia, una respuesta incompleta.

**Coste medido** sobre un monorepo sintético de 3.076 nodos y 8.408 aristas
(librería compartida → proyecto base → cuatro verticales encima):

| Consulta | Tokens |
|---|---|
| Un nodo cualquiera | ~60 |
| Un método base sobrescrito por 880 páginas | ~430 |
| Una utilidad de la librería de la que dependen 2.177 nodos | ~426 |

El coste **no crece con el tamaño del repositorio**: crece con la forma de la
respuesta, y ésa está acotada. Cuando hay muchos dependientes no se listan
nombres, se reparten por módulo:

```
DEPENDEN DIRECTAMENTE (880) - reparto por modulo:
  implements  Erp.Almacen          220   ej. Erp.Almacen.Pagina0.OnAppearing
  implements  Erp.Compras          220   ej. Erp.Compras.Pagina0.OnAppearing
  implements  Erp.Contabilidad     220   ej. Erp.Contabilidad.Pagina0.OnAppearing
  implements  Erp.Ventas           220   ej. Erp.Ventas.Pagina0.OnAppearing
```

Eso dice qué hay que probar. Una lista recortada de los doce primeros nombres,
en cambio, saldría entera del módulo que empieza por «a» y haría creer que el
cambio solo afecta a ése. `--all` devuelve el listado completo cuando hace falta.

## Qué no es

**No es un extractor automático.** No parsea tu código ni intenta adivinar nada.
Los hechos los registra quien los descubre — una persona o un agente. Esa
decisión tiene un precio (empiezas en cero) y una ventaja que ninguna
herramienta basada en parser tiene: **funciona con cualquier lenguaje**, porque
el formato de un hecho no depende de ningún parser. Un monorepo con backend en
Go, móvil en C# y web en TypeScript usa un único índice.

**No sustituye a grep.** Para llamadas explícitas grep es más barato y siempre
está al día. Edgelore cubre lo que grep no puede ver:

| Pregunta | Herramienta |
|---|---|
| ¿Quién llama a este método? | grep |
| ¿Quién ejecuta `OnAppearing` / `OnStart` / este job? | **edgelore** |
| ¿Qué ruta o literal resuelve a esta clase? | **edgelore** |
| ¿Quién consume este evento? | **edgelore** |
| ¿Quién escribe en esta tabla? | **edgelore** |
| ¿Qué se rompe si cambio esta clave de config? | **edgelore** |

**No necesita git.** Detecta que un hecho se ha quedado atrás comparando una
huella del contenido del fichero, no el historial. Funciona igual en SVN,
Mercurial, Perforce o un árbol exportado sin historia; donde hay git, además
anota el commit para que tengas algo que teclear.

**No es una red neuronal ni un índice vectorial.** Son ficheros Markdown con
frontmatter y un CLI que los consulta. Sin embeddings, sin base de datos, sin
API keys, sin telemetría, sin ninguna dependencia externa: nada sale de tu
máquina porque no hay nada que pueda salir.

## Instalación

Todavía no está publicado en npm (el nombre está reservado pero sin publicar).
Mientras tanto se instala desde el repositorio:

```bash
npm install -g github:YisusMula/edgelore

cd tu-repositorio
edgelore init
git add .edgelore .claude && git commit -m "Añade índice Edgelore"
```

Una vez publicado, `npm install -g edgelore`.

`edgelore init` no lleva argumentos: detecta el stack leyendo los ficheros de
proyecto e instala solo las reglas que correspondan. Un repositorio de Python no
recibe reglas de .NET; si no reconoce nada, no instala ninguna y te dice cómo
añadirlas. Instala además el almacén de hechos, una skill de Claude Code y dos
hooks. Requiere Node 20 o superior y nada más.

```bash
edgelore rules                    # ver instaladas y disponibles
edgelore rules add dotnet-maui    # añadir una; nunca pisa las existentes
edgelore init --rules all         # forzar todas al inicializar
```

**Para quitarlo:** `edgelore uninstall` retira la skill y los hooks y deja el
repositorio como estaba; los hechos se conservan salvo que pases `--all`. No se
toca `.gitignore` ni ningún otro fichero: Edgelore no genera artefactos
derivados que haya que ignorar.

## Uso diario

```bash
# ANTES de modificar algo: orientarse (barato)
edgelore impact Erp.Ui.DetallePage.OnAppearing

# ...y sacar la lista de sitios que revisar durante el cambio
edgelore impact Base.PageBase.OnAppearing --files --depth 1
edgelore impact Base.PageBase.OnAppearing --files --module Erp.Ventas

# consultar (antes de explorar el código)
edgelore query Erp.Ventas.PagoService     # nodo, aristas salientes y entrantes
edgelore find factura                     # cuando no sabes el id exacto
edgelore path AppShell Facturas           # cómo conecta A con B

# registrar (justo después de descubrir algo)
edgelore add Erp.Ui.DetallePage --file src/Ui/DetallePage.xaml.cs --kind maui-page
edgelore link AppShell Erp.Ui.DetallePage string-ref \
  --at src/AppShell.xaml.cs:42 --note 'registrada como ruta "detalle"'

# mantener
edgelore stale                            # hechos cuyo código cambió tras verificarlos
edgelore verify Erp.Ui.DetallePage        # confirmarlo en el commit actual
edgelore rename Erp.Ui.Vieja Erp.Ui.Nueva # al refactorizar: reapunta todo lo que la citaba
edgelore validate                         # esquema (rompe CI) + desincronización (avisa)
edgelore validate --max-age 365           # además: hechos que nadie reverifica desde hace un año
edgelore prune                            # hechos cuyo fichero ya no existe; --apply borra
edgelore stats                            # cobertura
```

`edgelore kinds` lista los tipos de nodo que conocen las reglas activas, y
`edgelore checklist <kind>` te dice qué comprobar al registrar uno.

## Cómo crece solo

Declarar el `kind` de un nodo aplica las reglas del framework de una vez:

```
$ edgelore add Erp.Ui.DetallePage --file src/Ui/DetallePage.xaml.cs --kind maui-page

Aristas añadidas por la regla del kind "maui-page":
  lifecycle   Erp.Ui.DetallePage.ctor
  lifecycle   Erp.Ui.DetallePage.OnAppearing
  lifecycle   Erp.Ui.DetallePage.OnDisappearing
  lifecycle   Erp.Ui.DetallePage.OnNavigatedTo
```

Cuarenta páginas, cuarenta veces, sin escribir una sola arista a mano. Las
reglas se declaran una vez en `.edgelore/rules/*.yaml` y se versionan con el repo.

Los dos hooks cierran el círculo sin depender de que nadie se acuerde:

- **Antes de editar** (`PreToolUse`), Claude recibe el alcance del cambio: quién
  depende de lo que va a tocar, marcando las relaciones que grep no encuentra.
  Esta es la mitad que evita que se olvide una.
- **Después de editar** (`PostToolUse`), recibe un recordatorio de los hechos
  afectados. El momento en que registrar un hallazgo es barato es justo después
  de descubrirlo.

## Diseñado para trabajo en equipo

- **Un fichero por nodo.** Un `REFERENCES.md` monolítico produce conflictos de
  merge en cada PR, y un índice que da guerra deja de rellenarse a las dos
  semanas. Los ficheros pequeños casi nunca chocan.
- **Las aristas entrantes se derivan, no se escriben.** Registrar una relación
  toca un único fichero.
- **Serialización determinista.** Las claves salen siempre en el mismo orden, así
  que los diffs muestran el cambio real y no una reordenación.
- **`edgelore validate` en CI, sin romper el build por desgaste normal.** Un hecho
  mal escrito rompe; que alguien borre un fichero, no. Romper el build por lo
  segundo deja el CI en rojo permanente, y un CI que lleva meses en rojo se
  ignora — perdiendo la única defensa automática contra que el índice mienta.
- **La salida está acotada por diseño.** Ningún comando puede devolver miles de
  líneas: el índice deja de ahorrar en el momento en que una consulta cuesta más
  que la búsqueda que evita. Eso incluye el texto libre — notas, disparadores,
  resúmenes — que se recorta al mostrarse indicando cuánto falta, aunque en el
  fichero pueda ser tan largo como haga falta. El hook automático es aún más
  estricto, porque su contexto entra sin que nadie lo pida. `--all` levanta
  todos los topes cuando de verdad quieres el volcado.

## Lo que va a doler

Dicho ahora y no dentro de tres meses:

- **Empiezas en cero.** El ahorro llega a los meses, no a la semana. Registra
  primero lo que ya os ha hecho perder tiempo, no intentes cubrir el proyecto
  entero.
- **Un hecho obsoleto es peor que ninguno**, porque se lee con confianza. Por eso
  cada hecho lleva `confidence` y una huella del contenido que describe, y por
  eso existe `edgelore stale`. Pasado un año sin reverificar, las consultas dejan de
  imprimir el sello a secas y añaden `<- sin reverificar desde hace N meses`: el
  índice no puede saber si un hecho sigue siendo cierto, pero sí puede dejar de
  aparentar que alguien lo ha comprobado hace poco. La disciplina no es opcional.
- **Depende del equipo.** El hook ayuda, pero si nadie registra nada, no hay
  índice. Empieza con dos o tres personas y las conexiones que más escuecen.

## Estado

v0.1. El núcleo curado está completo y probado (`npm test`, 142 pruebas).

Siguiente paso previsto: un extractor opcional basado en Roslyn que emita hechos
en este mismo formato con `source: extractor:roslyn`, para poblar las aristas
explícitas automáticamente y dejar la curación humana para lo que de verdad la
necesita. El formato ya distingue el origen de cada arista precisamente para eso.

## Documentación

- [`docs/SPEC.md`](docs/SPEC.md) — formato del hecho y vocabulario de aristas.
- [`docs/RULES.md`](docs/RULES.md) — cómo escribir reglas para vuestros frameworks.

## Licencia

MIT.
