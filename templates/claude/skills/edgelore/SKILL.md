---
name: edgelore
description: >-
  Indice curado de referencias ocultas de este repositorio: relaciones que grep no
  puede encontrar (lifecycle como OnAppearing u OnStart, rutas y reflexion por
  literal de texto, eventos, claves de configuracion, escrituras en base de datos).
  USALO SIEMPRE ANTES DE MODIFICAR cualquier funcion, metodo de ciclo de vida,
  regla de negocio o tabla, para saber que alcance tiene el cambio: peticiones
  como "cambia X", "modifica X", "refactoriza X" o "comprueba que no rompa nada"
  exigen ejecutar `edgelore impact` primero. Usalo tambien para responder "quien
  llama a esto", "quien ejecuta esto" o "como llega X hasta Y", y DESPUES de
  investigar o modificar codigo para registrar lo que hayas descubierto.
---

# Edgelore: consulta antes de buscar, registra despues de descubrir

Este repositorio mantiene un indice de hechos en `.edgelore/`, versionado con git y
construido poco a poco por el equipo. Contiene lo que el codigo no dice de si
mismo.

## Antes de MODIFICAR algo: `impact`

**Regla dura: antes de editar una funcion, un metodo de ciclo de vida, una
regla de negocio o una tabla, ejecuta `edgelore impact` sobre ella.** Aplica
siempre, incluso cuando nadie lo pida explicitamente. Si el usuario dice
"comprueba que no rompa nada", "cambia esto", "modifica X" o "refactoriza",
esto es lo primero que haces.

```
edgelore impact <Id>             # que depende de esto, de forma transitiva
edgelore impact <Id> --depth 6   # ampliar el radio
```

Devuelve las dependencias por niveles y marca `<- OCULTA A GREP` las que
ninguna busqueda de texto habria encontrado. Esas son las que se olvidan y las
que rompen cosas.

Al terminar, **enumera al usuario lo que has comprobado y lo que no**. El
indice cubre lo que el equipo ha registrado, no todo lo que existe: nunca
afirmes "no rompe nada" a secas. Di "segun el indice, esto afecta a A, B y C;
he comprobado los tres" y, si la cobertura es escasa, dilo.

## Antes de explorar: consulta

Cuando te pregunten quien usa algo o quien lo ejecuta, **consulta el indice
primero**. Cuesta unos cientos de tokens y a menudo responde de golpe lo que
costaria diez busquedas:

```
edgelore query <Id>              # el nodo, lo que sale de el y lo que apunta hacia el
edgelore find <texto>            # buscar cuando no sabes el id exacto
edgelore path <desde> <hasta>    # como conecta A con B
```

`edgelore query` devuelve dos bloques. **LLEGA DESDE** es el importante: son las
aristas entrantes, es decir, quien depende de este nodo. Esa es justo la
pregunta que grep no sabe contestar cuando la relacion no esta escrita.

El indice **complementa** a grep, no lo sustituye. Para llamadas explicitas grep
sigue siendo mas barato y esta siempre al dia. El indice gana donde grep es
ciego:

| Situacion | Herramienta |
|---|---|
| Quien llama a este metodo (llamada escrita) | grep |
| Quien ejecuta `OnAppearing`, `OnStart`, un job | **edgelore** |
| Que ruta o literal resuelve a esta clase | **edgelore** |
| Quien consume este evento | **edgelore** |
| Quien escribe en esta tabla | **edgelore** |
| Que pasa si cambio esta clave de configuracion | **edgelore** |

Trata cada hecho segun su etiqueta de confianza. `~SIN VERIFICAR` y `~probable`
son pistas que hay que comprobar, no verdades. Si `edgelore stale` marca un hecho, el
codigo cambio despues de verificarlo: leelo antes de fiarte.

## Despues de descubrir: registra

Este es el habito que hace que el indice crezca. **Cuando acabas de investigar
algo, registrarlo cuesta casi nada** porque ya tienes la respuesta delante. Lo
caro fue descubrirla. Registrala y deja de pagarla cada vez.

Registra cuando:

- Has hecho una exploracion larga y has encontrado una conexion no evidente.
- Has modificado codigo y has entendido algo que costo entender.
- Te has topado con una sorpresa: algo se ejecutaba y no estaba claro por que.

```
# un nodo nuevo, con las aristas implicitas del framework ya aplicadas
edgelore add Erp.Ui.DetallePage --file src/Ui/DetallePage.xaml.cs --kind maui-page \
  --summary "Detalle de factura; carga en OnAppearing, no en el constructor"

# una relacion concreta
edgelore link AppShell Erp.Ui.DetallePage string-ref \
  --at src/AppShell.xaml.cs:42 --note 'registrada como ruta "detalle"'

edgelore link Erp.Ventas.PagoService Facturas writes --confidence certain
edgelore verify Erp.Ui.DetallePage      # tras confirmar que sigue siendo cierto
```

`edgelore kinds` lista los tipos de nodo que conocen las reglas activas.
`edgelore checklist <kind>` te dice que comprobar para ese tipo: usalo cuando
registres un nodo nuevo, porque son justo las preguntas cuya respuesta se pierde.

### Que merece la pena registrar

Registra lo que **no se deduce leyendo el fichero**:

- `lifecycle` — lo invoca el runtime: `OnAppearing`, `OnStart`, un ctor por DI.
  Siempre con `--trigger`: sin el, dentro de seis meses nadie sabra interpretarlo.
- `string-ref` — rutas, reflexion, DI por nombre, procedimientos invocados por
  cadena. Siempre con `--at` apuntando al literal.
- `event` — quien publica y quien consume.
- `config` — que codigo depende de que clave.
- `writes` / `reads` — sobre todo escrituras en tablas compartidas.
- `schedules` — que dispara un job y cada cuanto.

No registres lo que grep encuentra en un segundo. Un indice lleno de llamadas
explicitas es ruido que hay que mantener y que no ahorra nada.

### Cuando propongas registrar algo

Si acabas de resolver algo no evidente y no esta en el indice, **dilo y ofrece el
comando concreto**. No lo escribas sin avisar: un hecho equivocado es peor que
ninguno, y quien esta delante es quien puede confirmarlo.

## Reglas de higiene

- Un hecho por nodo, en su propio fichero. Nunca edites `.edgelore/nodes/*.md` a mano
  si puedes usar `edgelore add` o `edgelore link`: el CLI valida y normaliza, lo que
  mantiene los diffs limpios y evita conflictos de merge.
- Nunca vuelques el indice entero en el contexto. Consultas dirigidas siempre.
  Volcarlo gasta mas tokens de los que ahorra, que es precisamente lo que Edgelore
  existe para evitar.
- Si un hecho resulta ser falso, corrigelo o borralo en el momento.
  `edgelore validate` corre en CI y protege la coherencia, pero no puede saber si un
  hecho miente.
