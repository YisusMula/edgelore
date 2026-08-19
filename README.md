# Nexo

**Índice curado de las referencias que tu código no declara.**

Un `OnAppearing` no lo llama nadie. Un servicio de Windows lo arranca el SCM.
Una página se resuelve desde el literal `"detalle"`. Un procedimiento almacenado
se invoca por su nombre en una cadena. Nada de eso aparece como una llamada en
ningún sitio, así que `grep NombreDeLaClase` no lo encuentra — y quien pregunta
«¿quién ejecuta esto?» se queda sin respuesta.

Nexo es el sitio donde el equipo escribe esas conexiones, una vez, cuando las
descubre. Vive en `.nexo/`, se versiona con git, y se consulta con una orden.

```
$ nexo query Erp.Ui.DetallePage

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

## Qué no es

**No es un extractor automático.** No parsea tu código ni intenta adivinar nada.
Los hechos los registra quien los descubre — una persona o un agente. Esa
decisión tiene un precio (empiezas en cero) y una ventaja que ninguna
herramienta basada en parser tiene: **funciona con cualquier lenguaje**, porque
el formato de un hecho no depende de ningún parser. Un monorepo con backend en
Go, móvil en C# y web en TypeScript usa un único índice.

**No sustituye a grep.** Para llamadas explícitas grep es más barato y siempre
está al día. Nexo cubre lo que grep no puede ver:

| Pregunta | Herramienta |
|---|---|
| ¿Quién llama a este método? | grep |
| ¿Quién ejecuta `OnAppearing` / `OnStart` / este job? | **nexo** |
| ¿Qué ruta o literal resuelve a esta clase? | **nexo** |
| ¿Quién consume este evento? | **nexo** |
| ¿Quién escribe en esta tabla? | **nexo** |
| ¿Qué se rompe si cambio esta clave de config? | **nexo** |

**No es una red neuronal ni un índice vectorial.** Son ficheros Markdown con
frontmatter y un CLI que los consulta. Sin embeddings, sin base de datos, sin
API keys, sin telemetría, sin ninguna dependencia externa: nada sale de tu
máquina porque no hay nada que pueda salir.

## Instalación

Todavía no está publicado en npm. Se instala desde el repositorio:

```bash
git clone <url-de-este-repo> nexo && cd nexo && npm install -g .

cd tu-repositorio
nexo init --rules dotnet-core,dotnet-maui,dotnet-winservice,dotnet-data
git add .nexo .claude && git commit -m "Añade índice Nexo"
```

`nexo init` instala el almacén de hechos, las reglas del stack elegido, una
skill de Claude Code y un hook `PostToolUse`. Requiere Node 20 o superior y
nada más.

## Uso diario

```bash
# consultar (antes de explorar el código)
nexo query Erp.Ventas.PagoService     # nodo, aristas salientes y entrantes
nexo find factura                     # cuando no sabes el id exacto
nexo path AppShell Facturas           # cómo conecta A con B

# registrar (justo después de descubrir algo)
nexo add Erp.Ui.DetallePage --file src/Ui/DetallePage.xaml.cs --kind maui-page
nexo link AppShell Erp.Ui.DetallePage string-ref \
  --at src/AppShell.xaml.cs:42 --note 'registrada como ruta "detalle"'

# mantener
nexo stale                            # hechos cuyo código cambió tras verificarlos
nexo verify Erp.Ui.DetallePage        # confirmarlo en el commit actual
nexo validate --strict                # coherencia del índice; para CI
nexo stats                            # cobertura
```

`nexo kinds` lista los tipos de nodo que conocen las reglas activas, y
`nexo checklist <kind>` te dice qué comprobar al registrar uno.

## Cómo crece solo

Declarar el `kind` de un nodo aplica las reglas del framework de una vez:

```
$ nexo add Erp.Ui.DetallePage --file src/Ui/DetallePage.xaml.cs --kind maui-page

Aristas añadidas por la regla del kind "maui-page":
  lifecycle   Erp.Ui.DetallePage.ctor
  lifecycle   Erp.Ui.DetallePage.OnAppearing
  lifecycle   Erp.Ui.DetallePage.OnDisappearing
  lifecycle   Erp.Ui.DetallePage.OnNavigatedTo
```

Cuarenta páginas, cuarenta veces, sin escribir una sola arista a mano. Las
reglas se declaran una vez en `.nexo/rules/*.yaml` y se versionan con el repo.

El hook cierra el círculo: cuando alguien edita un fichero que ya tiene hechos
registrados, Claude recibe un aviso con lo que hay y con qué confirmar. El
momento en que registrar un hallazgo es barato es justo después de descubrirlo.

## Diseñado para trabajo en equipo

- **Un fichero por nodo.** Un `REFERENCES.md` monolítico produce conflictos de
  merge en cada PR, y un índice que da guerra deja de rellenarse a las dos
  semanas. Los ficheros pequeños casi nunca chocan.
- **Las aristas entrantes se derivan, no se escriben.** Registrar una relación
  toca un único fichero.
- **Serialización determinista.** Las claves salen siempre en el mismo orden, así
  que los diffs muestran el cambio real y no una reordenación.
- **`nexo validate` en CI.** Es la única defensa automática contra que el índice
  acumule mentiras.

## Lo que va a doler

Dicho ahora y no dentro de tres meses:

- **Empiezas en cero.** El ahorro llega a los meses, no a la semana. Registra
  primero lo que ya os ha hecho perder tiempo, no intentes cubrir el proyecto
  entero.
- **Un hecho obsoleto es peor que ninguno**, porque se lee con confianza. Por eso
  cada hecho lleva `confidence` y el commit en que se verificó, y por eso existe
  `nexo stale`. La disciplina no es opcional.
- **Depende del equipo.** El hook ayuda, pero si nadie registra nada, no hay
  índice. Empieza con dos o tres personas y las conexiones que más escuecen.

## Estado

v0.1. El núcleo curado está completo y probado (`npm test`, 48 pruebas).

Siguiente paso previsto: un extractor opcional basado en Roslyn que emita hechos
en este mismo formato con `source: extractor:roslyn`, para poblar las aristas
explícitas automáticamente y dejar la curación humana para lo que de verdad la
necesita. El formato ya distingue el origen de cada arista precisamente para eso.

## Documentación

- [`docs/SPEC.md`](docs/SPEC.md) — formato del hecho y vocabulario de aristas.
- [`docs/RULES.md`](docs/RULES.md) — cómo escribir reglas para vuestros frameworks.

## Licencia

MIT.
