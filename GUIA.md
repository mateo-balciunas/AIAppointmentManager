# Guía de implementación — Agente de IA Omnicanal para agendamiento de citas

**Proyecto:** `AIAppointmentManager` (v2.0)
**Predecesor:** `AppointmentManager` (v1, basado en reglas)

Sistema de agendamiento conversacional sobre WhatsApp, Instagram y Telegram, con
Google Calendar como calendario de destino.

## Stack y restricciones

| Área | Elección |
|---|---|
| Orquestación de canales | n8n (self-hosted) |
| Bucle del agente | Servicio TypeScript propio (`agent-core`) |
| IA | API nativa del LLM con function calling, **agnóstica de proveedor** |
| Validación | Zod (fuente de verdad de los tipos) |
| Base de datos | Supabase (PostgreSQL) |
| Calendario | Google Calendar API |
| Despliegue | Docker Compose + Caddy |

**Restricciones estrictas:**

1. Prohibido LangChain, LlamaIndex o cualquier framework de orquestación de IA.
   Todo con la API nativa del LLM y n8n.
2. Sin RAG.
3. TypeScript modular, `strict`, con manejo de errores explícito.
4. Independencia de proveedor de LLM: Anthropic, Gemini y OpenAI intercambiables.

## Índice

- [Fase 0 — Diagnóstico de la v1](#fase-0--diagnóstico-de-la-v1)
- [Fase 1 — Decisiones arquitectónicas](#fase-1--decisiones-arquitectónicas)
- [Fase 2 — Arquitectura y flujo de datos](#fase-2--arquitectura-y-flujo-de-datos)
- [Fase 3 — Entorno con Docker](#fase-3--entorno-con-docker)
- [Fase 4 — Base de datos](#fase-4--base-de-datos)
- [Fase 5 — TypeScript, Zod y el puerto LLM](#fase-5--typescript-zod-y-el-puerto-llm)
- [Fase 6 — Configuración de n8n](#fase-6--configuración-de-n8n)
- [Fase 7 — Manejo de casos extremos](#fase-7--manejo-de-casos-extremos)
- [Fase 8 — Orden de implementación](#fase-8--orden-de-implementación)
- [Apéndice A — Inventario de secretos](#apéndice-a--inventario-de-secretos)
- [Apéndice B — Errores comunes](#apéndice-b--errores-comunes)

---

# Fase 0 — Diagnóstico de la v1

Antes de escribir código nuevo hay que corregir tres cosas del esquema de la v1
que son incompatibles con un agente omnicanal. No son cuestión de preferencia.

### Blocker 1 — `clients.email` es `UNIQUE NOT NULL`

Un usuario de WhatsApp o Instagram no proporciona email. Con el esquema actual el
agente no puede crear un cliente sin inventarse uno. Si genera
`wa_573001234567@fake.com`, acumulas basura y duplicas la persona cuando escriba
por Telegram.

Corrección: `email` y `full_name` pasan a nullable, unicidad case-insensitive vía
índice parcial, y la identidad real se mueve a `channel_identities`.

### Blocker 2 — Condición de carrera en `fn_book_appointment`

La función hace `SELECT COUNT(*)` para detectar solapamientos y luego inserta.
Dos turnos concurrentes pueden pasar ambos el `COUNT` y crear dos citas en el
mismo hueco. En la v1 apenas importaba porque un humano llamaba a la API
despacio; en la v2 el agente dispara reservas en paralelo desde tres canales.

La migración `0001` ya habilita `btree_gist` pero nunca crea la constraint de
exclusión que lo usaría. Corrección: constraint `EXCLUDE USING gist`.

### Blocker 3 — No hay estado conversacional

`clients`, `professionals`, `appointments`, `audit_logs` e `idempotency_keys`
cubren transacciones, no diálogo. Falta identidad por canal, hilo de mensajes,
historial de tool calls, servicios con duración y horario de atención.

### Lo que sí se reutiliza sin cambios

- Tablas `professionals`, `appointments`, `audit_logs`, `idempotency_keys`.
- RPC `fn_update_appointment`, `fn_cancel_appointment`,
  `fn_claim_idempotency_key`, `fn_complete_idempotency_key`.
- Workflows `Appointments - Reminder (Cron)` y `Error Handler (Global)`.
- El patrón de Dead Letter Queue.

### Una señal a tener en cuenta

El README de la v1 dice: *"Validación con TypeScript (manual, workaround por bug
de Zod 3.25+)"*, y el `docker-compose.yml` tiene `NODE_FUNCTION_ALLOW_EXTERNAL=zod`
con un `Dockerfile.n8n` custom. Hubo una pelea con Zod dentro de los Code nodes
de n8n. Esa cicatriz es el argumento de la decisión de la Fase 1: en la v2 Zod
sale de n8n y el `Dockerfile.n8n` desaparece.

---

# Fase 1 — Decisiones arquitectónicas

## 1.1 Dónde vive el bucle de tool calling

Un agente con function calling no es una petición HTTP, es un **bucle**:

```
usuario → LLM → "quiero llamar check_availability" → ejecutas la tool →
devuelves el resultado al LLM → LLM decide otra tool o responde texto → ...
```

El modelo puede iterar una vez o cinco antes de producir texto final.

**Opción A — el bucle dentro de n8n.** Un IF node que vuelve al HTTP Request
mientras haya tool calls. Técnicamente posible. En la práctica: los ciclos en
n8n son frágiles, cada iteración es un nodo más que depurar en una ejecución de
40 pasos, no hay tipos, no hay tests unitarios, y se repite la pelea con Zod.

**Opción B — n8n es el adaptador de canales, no el cerebro.** Un servicio
TypeScript (`agent-core`) es dueño del bucle. **Esta es la elegida.**

| Responsabilidad | Dónde | Por qué |
|---|---|---|
| Recibir webhooks, verificar firmas | n8n | Es lo que n8n hace mejor: I/O y glue |
| Normalizar los 3 payloads a uno canónico | n8n | Cambios de API sin recompilar |
| Bucle LLM + tool calling + validación | `agent-core` | Necesita tipos, tests, try/catch |
| Lógica de negocio | Postgres RPC + `agent-core` | Las RPC de la v1 ya existen |
| Enviar respuesta al canal correcto | n8n | Switch node, trivial |
| Crons: recordatorios, reconciliación | n8n | Ya funciona en la v1 |

Beneficio inmediato: **se borra el `Dockerfile.n8n` y el
`NODE_FUNCTION_ALLOW_EXTERNAL=zod`**. Zod corre en un servicio Node con la
versión que controlas y con `npm test`. El bug que obligó a validar a mano
desaparece por construcción.

Esto no viola la prohibición de frameworks: el bucle son ~80 líneas sobre
`fetch`. LangChain no aporta nada aquí y esconde el array `messages`, que es
justo lo que hay que controlar.

## 1.2 Agnosticismo de proveedor: qué se compra y qué no

Es viable y barato **porque** se prohibió LangChain. La agnosticidad sale cara
cuando se intenta abstraer todo lo que hace un framework (memoria, cadenas,
retrievers, callbacks). Aquí solo hay que abstraer una cosa: "dame el siguiente
turno del asistente". Son ~150-250 líneas por adaptador, una vez.

No hace falta streaming (se responde por WhatsApp, no en un chat con typing en
vivo), ni embeddings (sin RAG), ni agentes anidados.

**Lo que se compra:** tests deterministas gratis (vía `FakeProvider`), opción de
enrutar turnos simples a un modelo barato, y protección real ante cambios de
precio o deprecación de modelos.

**Lo que NO se compra:** cambiar de proveedor sin pensar. El código es portable;
el comportamiento no. Un prompt afinado con Claude se comporta distinto en
Gemini: distinta propensión a llamar tools de más, a pedir aclaración, distinta
verbosidad (relevante con el límite de 4096 caracteres de WhatsApp). Cambiar de
proveedor es **barato en código y caro en validación**. Por eso la Fase 8 incluye
un set de evals.

## 1.3 Reglas de diseño que se repiten en todo el documento

**El prompt optimiza, el código garantiza.** Ninguna invariante de negocio
depende de que el modelo se porte bien. El caso canónico: "verifica
disponibilidad antes de reservar" no se pide en el prompt, se impone con
`slot_offers` (Fase 4.7).

**Supabase es la verdad, Google Calendar es una proyección.** La API de Google
tiene rate limits, latencia variable y cae. Si es la fuente de verdad, cada
consulta de disponibilidad depende de una API externa. En su lugar: la cita se
confirma en Postgres (transaccional, con la constraint de exclusión) y Calendar
se sincroniza después. Si falla, `google_sync_status = 'pending'` y un cron
reintenta. **La cita del cliente es válida aunque Google esté caído.** Además la
disponibilidad se calcula con un query local, no con una llamada de red.

**UTC en la base de datos, zona del negocio solo en los bordes.**

---

# Fase 2 — Arquitectura y flujo de datos

## 2.1 Topología

```
┌──────────────┐  ┌───────────┐  ┌──────────┐
│ WhatsApp     │  │ Instagram │  │ Telegram │
│ Cloud API    │  │ Graph API │  │ Bot API  │
└──────┬───────┘  └─────┬─────┘  └────┬─────┘
       │ webhook        │              │
       └────────────────┼──────────────┘
                        ▼
              ┌──────────────────────┐
              │  Caddy (HTTPS/TLS)   │
              └──────────┬───────────┘
                         ▼
       ┌─────────────────────────────────────┐
       │  n8n — CAPA DE CANAL                │
       │  Ingress ×3 → Normalize → Dedup     │
       │  Egress ×1 (Switch por canal)       │
       │  Crons: recordatorios, reconcile    │
       └──────────┬──────────────────────────┘
                  │ POST /v1/agent/turn
                  ▼
       ┌─────────────────────────────────────┐
       │  agent-core (TypeScript/Node)       │
       │  ┌───────────────────────────────┐  │
       │  │ 1. Advisory lock              │  │
       │  │ 2. Resolver identidad         │  │
       │  │ 3. Cargar historial canónico  │  │
       │  │ 4. LLM vía puerto ◄─────────┐ │  │
       │  │ 5. Zod.safeParse(input)     │ │  │
       │  │ 6. Ejecutar tool ───────────┘ │  │
       │  │ 7. Persistir + responder      │  │
       │  └───────────────────────────────┘  │
       └───┬──────────────┬──────────────┬───┘
           ▼              ▼              ▼
   ┌────────────┐  ┌────────────┐  ┌──────────┐
   │ LlmProvider│  │ Supabase   │  │ Google   │
   │ anthropic  │  │ PostgreSQL │  │ Calendar │
   │ gemini     │  │ ← VERDAD   │  │ ← espejo │
   │ openai     │  └────────────┘  └──────────┘
   │ fake       │
   └────────────┘
```

## 2.2 El viaje completo de un mensaje

Ejemplo: *"Hola, quiero cita para corte mañana a las 3"* por WhatsApp.

**1. Meta entrega el webhook.** `POST` con envelope anidado
(`entry[0].changes[0].value.messages[0]`), incluyendo `wamid` (ID único del
mensaje) y `wa_id` (teléfono).

**2. n8n verifica la firma.** Meta firma el body con HMAC-SHA256 usando el App
Secret, en `X-Hub-Signature-256`. Sin esta verificación el endpoint es público y
cualquiera inyecta conversaciones falsas. Hay que hashear el **body crudo**: si
usas `JSON.stringify` sobre el objeto parseado, cambian el orden y los espacios y
la firma nunca coincide.

**3. n8n responde 200 inmediatamente.** Un turno con 2-3 tool calls puede tardar
10-20 segundos. Si esperas a terminar, Meta reintenta y el usuario recibe
respuestas duplicadas.

**4. Deduplicación.** El `wamid` se inserta en `messages.provider_message_id`,
que tiene índice único. Si choca, se aborta. Es el patrón de idempotencia de la
v1 pero con la clave que ya da el proveedor.

**5. Normalización.** n8n aplana cada canal a un evento canónico:

```json
{
  "channel": "whatsapp",
  "external_user_id": "573001234567",
  "provider_message_id": "wamid.HBgM...",
  "display_name": "Mateo",
  "message_type": "text",
  "text": "Hola, quiero cita para corte mañana a las 3",
  "received_at": "2026-08-19T17:32:11Z"
}
```

Esta frontera es lo que hace el sistema omnicanal: `agent-core` nunca sabe de qué
canal viene, y añadir un cuarto canal es un workflow de n8n, cero cambios en
TypeScript.

**6. `agent-core` toma el lock y carga contexto.** Si el usuario manda tres
mensajes seguidos, tres turnos corren en paralelo sobre la misma conversación y
se pisan el historial. Solución: `pg_advisory_xact_lock(hashtext(conversation_id))`.
Postgres serializa los turnos de esa conversación sin bloquear a otros usuarios.

Luego resuelve identidad: busca `channel_identities(channel, external_id)`; si no
existe, crea identidad + cliente.

**7. Construye el system prompt** con datos frescos inyectados en runtime:

- Fecha y hora actual en zona del negocio, con día de la semana escrito. Sin
  esto "mañana" es indecidible y el modelo **inventará** una fecha con total
  confianza en lugar de admitirlo.
- Zona horaria y horario de atención.
- Catálogo de servicios con duraciones y profesionales, leídos de la BD, para que
  no invente "corte premium".
- Políticas: nunca confirmar sin verificar, nunca inventar un hueco, pedir
  aclaración si la fecha es ambigua.

**8. Primera llamada al LLM** vía el puerto, con `messages` + `tools`. El modelo
no responde texto: emite un `tool_call` a `check_availability` con
`{ service_slug: "corte", date: "2026-08-20", preferred_time: "15:00" }`.

**9. Zod valida el input.** El LLM es una fuente no confiable. Si `safeParse`
falla, **no se lanza excepción**: el error de validación vuelve al modelo como
resultado de la tool y él se autocorrige. Este es el mecanismo de retry que daría
LangChain, en cinco líneas.

**10. Se ejecuta la tool.** `check_availability` consulta horario, citas
existentes y bloqueos. Descubre que las 15:00 están ocupadas y devuelve
alternativas — y junto a cada hueco emite un **`slot_token`**, una fila en BD con
expiración. `book_appointment` **exige** un token válido, así que "verifica antes
de reservar" deja de ser una súplica y pasa a ser una imposibilidad estructural.

**11. Segunda vuelta.** El resultado vuelve al modelo, que ahora sí produce
texto: *"Las 3 están ocupadas, pero tengo 14:30 o 16:00. ¿Cuál te va mejor?"*

**12. Persistencia.** El turno completo se guarda en `messages` (incluidos los
tool calls, para auditoría y para reconstruir contexto), se suelta el lock y se
devuelve a n8n `{ reply_text, channel, external_user_id }`.

**13. Egress.** El Switch node enruta al canal y envía.

**14. La reserva.** El usuario dice "16:00". Nuevo turno, el modelo llama
`book_appointment` con el token. `agent-core` invoca `fn_book_appointment_v2`,
Postgres inserta con la constraint de exclusión protegiendo la carrera, y **solo
después** de que Postgres confirme se crea el evento en Google Calendar.

---

# Fase 3 — Entorno con Docker

## 3.1 Supabase Cloud vs self-hosted

**Empezar con Supabase Cloud.** Self-hostear son ~10 contenedores (Kong, GoTrue,
PostgREST, Realtime, Storage, Meta, Analytics) y en este proyecto no se usa Auth,
ni Storage, ni Realtime: se usa Postgres y PostgREST. Es añadir superficie de
fallo sin beneficio. La v1 ya usa Cloud.

Si más adelante hace falta self-host por normativa de datos, la ruta es el
`docker-compose.yml` oficial de `supabase/supabase` y apuntar `SUPABASE_URL` a la
URL interna de Kong. El código no cambia porque todo va contra PostgREST.

## 3.2 `docker-compose.yml`

Cambios frente a la v1: se añade `agent-core`, se añade Caddy para TLS (Meta
exige HTTPS con certificado válido, no acepta self-signed), n8n pasa de SQLite a
Postgres, y desaparece el `Dockerfile.n8n`.

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on: [n8n]

  n8n-db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: n8n
      POSTGRES_USER: n8n
      POSTGRES_PASSWORD: ${N8N_DB_PASSWORD:?required}
    volumes:
      - n8n_db_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U n8n -d n8n"]
      interval: 10s
      timeout: 5s
      retries: 5

  n8n:
    image: docker.n8n.io/n8nio/n8n:latest
    restart: unless-stopped
    environment:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: n8n-db
      DB_POSTGRESDB_DATABASE: n8n
      DB_POSTGRESDB_USER: n8n
      DB_POSTGRESDB_PASSWORD: ${N8N_DB_PASSWORD:?required}
      N8N_HOST: ${N8N_HOST:?required}
      N8N_PROTOCOL: https
      WEBHOOK_URL: https://${N8N_HOST}/
      N8N_ENCRYPTION_KEY: ${N8N_ENCRYPTION_KEY:?required}
      N8N_USER_MANAGEMENT_JWT_SECRET: ${N8N_JWT_SECRET:?required}
      N8N_BLOCK_ENV_ACCESS_IN_NODE: "false"
      GENERIC_TIMEZONE: ${BUSINESS_TIMEZONE:-America/Bogota}
      TZ: ${BUSINESS_TIMEZONE:-America/Bogota}
      N8N_DIAGNOSTICS_ENABLED: "false"
      N8N_PAYLOAD_SIZE_MAX: "16"
      EXECUTIONS_DATA_PRUNE: "true"
      EXECUTIONS_DATA_MAX_AGE: "336"
      AGENT_CORE_URL: http://agent-core:8080
      AGENT_CORE_TOKEN: ${AGENT_CORE_TOKEN:?required}
      META_APP_SECRET: ${META_APP_SECRET:?required}
      META_VERIFY_TOKEN: ${META_VERIFY_TOKEN:?required}
      WHATSAPP_PHONE_NUMBER_ID: ${WHATSAPP_PHONE_NUMBER_ID:-}
      WHATSAPP_TOKEN: ${WHATSAPP_TOKEN:-}
      IG_PAGE_TOKEN: ${IG_PAGE_TOKEN:-}
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:-}
      TELEGRAM_WEBHOOK_SECRET: ${TELEGRAM_WEBHOOK_SECRET:-}
    volumes:
      - n8n_data:/home/node/.n8n
    depends_on:
      n8n-db: { condition: service_healthy }
      agent-core: { condition: service_started }

  agent-core:
    build:
      context: ./agent-core
      dockerfile: Dockerfile
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: "8080"
      AGENT_CORE_TOKEN: ${AGENT_CORE_TOKEN:?required}
      SUPABASE_URL: ${SUPABASE_URL:?required}
      SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_ROLE_KEY:?required}
      SUPABASE_DB_URL: ${SUPABASE_DB_URL:?required}
      LLM_DEFAULT_PROVIDER: ${LLM_DEFAULT_PROVIDER:-anthropic}
      LLM_DEFAULT_MODEL: ${LLM_DEFAULT_MODEL:?required}
      LLM_FALLBACK_PROVIDER: ${LLM_FALLBACK_PROVIDER:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      GEMINI_API_KEY: ${GEMINI_API_KEY:-}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      MAX_TOOL_ITERATIONS: ${MAX_TOOL_ITERATIONS:-6}
      GOOGLE_SA_JSON: ${GOOGLE_SA_JSON:-}
      GOOGLE_CALENDAR_ID: ${GOOGLE_CALENDAR_ID:-}
      BUSINESS_TIMEZONE: ${BUSINESS_TIMEZONE:-America/Bogota}
      TZ: UTC
      LOG_LEVEL: info
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 20s

volumes:
  n8n_data:
  n8n_db_data:
  caddy_data:
  caddy_config:
```

Detalles que muerden si se ignoran:

- **`${VAR:?required}`** hace fallar `docker compose up` ruidosamente si falta una
  variable, en vez de arrancar con `undefined` y fallar tres horas después.
- **`N8N_ENCRYPTION_KEY` explícita.** n8n la autogenera y la guarda en el volumen;
  si se pierde el volumen sin tener la key, **se pierden todas las credenciales**
  sin recuperación posible. Generarla con `openssl rand -hex 32` y guardarla.
- **`TZ: UTC` en `agent-core`** con `BUSINESS_TIMEZONE` aparte. La lógica interna
  opera en UTC; la zona del negocio es un dato explícito. Si el contenedor va en
  hora local, cada bug de fechas será irreproducible.
- **Ningún puerto publicado** en `n8n` ni `agent-core`. Solo Caddy toca internet.
- **`AGENT_CORE_TOKEN`**: bearer compartido para que solo n8n invoque al agente.
  Sin él, cualquier cosa en la red Docker puede gastar presupuesto de LLM.
- **`EXECUTIONS_DATA_PRUNE`**: con tres canales el historial de ejecuciones crece
  rápido y hace la UI inusable. 336 horas = 14 días.
- **`N8N_BLOCK_ENV_ACCESS_IN_NODE: "false"`** es necesario para leer `$env` en
  Code nodes. Si `$env.META_APP_SECRET` sale `undefined`, esta es la causa.

## 3.3 `Caddyfile`

```
{$N8N_HOST} {
    encode gzip
    handle /webhook/* {
        reverse_proxy n8n:5678
    }
    handle /webhook-test/* {
        reverse_proxy n8n:5678
    }
    handle {
        reverse_proxy n8n:5678
    }
}
```

## 3.4 Desarrollo local: el problema del webhook

Meta y Telegram necesitan una URL pública HTTPS. En local se usa un túnel
(`cloudflared tunnel --url http://localhost:5678` o ngrok).

El detalle que rompe a todo el mundo: **hay que fijar `WEBHOOK_URL` a la URL del
túnel**. Si no, n8n muestra webhooks con `localhost` y registras una URL inútil
en Meta.

Si el túnel es efímero la URL cambia en cada reinicio y hay que re-suscribir el
webhook. Con Cloudflare, un túnel nombrado con dominio fijo evita ese ciclo; vale
la media hora de setup.

---

# Fase 4 — Base de datos

Todo va en una migración nueva, `0006_phase4_omnichannel.sql`, **aditiva** sobre
la v1. No borrar nada.

## 4.0 Comprobación previa

La constraint de exclusión falla si ya hay solapamientos de las pruebas de la v1.
Localizarlos y limpiarlos antes:

```sql
SELECT a.id, b.id, a.professional_id, a.start_time, b.start_time
FROM appointments a
JOIN appointments b
  ON a.professional_id = b.professional_id
 AND a.id < b.id
 AND a.status IN ('scheduled','confirmed')
 AND b.status IN ('scheduled','confirmed')
 AND tstzrange(a.start_time, a.end_time, '[)')
  && tstzrange(b.start_time, b.end_time, '[)');
```

## 4.1 Extensiones y tipos

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
  CREATE TYPE channel_type AS ENUM ('whatsapp', 'instagram', 'telegram');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

## 4.2 Corregir `clients` (Blocker 1)

El modelo mental correcto: una **persona** puede tener múltiples **identidades de
canal**. Mateo por WhatsApp y Mateo por Telegram son un `client`, dos
`channel_identities`.

```sql
ALTER TABLE clients ALTER COLUMN email DROP NOT NULL;
ALTER TABLE clients ALTER COLUMN full_name DROP NOT NULL;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_email_key;
DROP INDEX IF EXISTS clients_email_idx;

CREATE UNIQUE INDEX IF NOT EXISTS clients_email_unique_idx
  ON clients (lower(email)) WHERE email IS NOT NULL;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS phone_e164 text,
  ADD COLUMN IF NOT EXISTS preferred_locale text NOT NULL DEFAULT 'es',
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/Bogota';

CREATE UNIQUE INDEX IF NOT EXISTS clients_phone_unique_idx
  ON clients (phone_e164) WHERE phone_e164 IS NOT NULL;
```

`full_name` también pasa a nullable: el agente aprende el nombre a mitad de
conversación, no puede saberlo al crear la fila. El índice sobre `lower(email)`
da unicidad case-insensitive y permite múltiples NULL. El teléfono se guarda
siempre en E.164 (`+573001234567`) o habrá duplicados por formato.

## 4.3 Identidades de canal

```sql
CREATE TABLE IF NOT EXISTS channel_identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel         channel_type NOT NULL,
  external_id     text NOT NULL,
  display_name    text,
  raw_profile     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_blocked      boolean NOT NULL DEFAULT false,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_identities_unique UNIQUE (channel, external_id)
);

CREATE INDEX IF NOT EXISTS channel_identities_client_idx
  ON channel_identities (client_id);
```

El `UNIQUE (channel, external_id)` es el ancla de toda la resolución de
identidad. `is_blocked` es el kill switch por usuario cuando alguien abusa del
bot; se agradece tenerlo antes de necesitarlo.

## 4.4 Servicios

La v1 recibe `start_time` y `end_time` de un cliente que ya sabe cuánto dura la
cita. Un usuario de WhatsApp dice "corte" y el sistema debe derivar la duración.
Sin esto, el LLM tiene que inventarse la hora de fin.

```sql
CREATE TABLE IF NOT EXISTS services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text UNIQUE NOT NULL,
  name             text NOT NULL,
  description      text,
  duration_minutes int NOT NULL CHECK (duration_minutes > 0),
  buffer_after_min int NOT NULL DEFAULT 0 CHECK (buffer_after_min >= 0),
  price_cents      int,
  currency         text NOT NULL DEFAULT 'COP',
  is_active        boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS professional_services (
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  service_id      uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (professional_id, service_id)
);
```

`buffer_after_min` es el detalle que se descubre tarde: limpieza entre citas,
notas del profesional. Modelarlo desde el principio; retrofitearlo obliga a
recalcular disponibilidad.

## 4.5 Horario de atención y bloqueos

Sin esto el agente reservará citas a las 3 de la mañana del domingo.

```sql
CREATE TABLE IF NOT EXISTS business_hours (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id uuid REFERENCES professionals(id) ON DELETE CASCADE,
  weekday         int NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = domingo
  opens_at        time NOT NULL,
  closes_at       time NOT NULL,
  CONSTRAINT business_hours_valid CHECK (closes_at > opens_at)
);

CREATE TABLE IF NOT EXISTS time_off (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id uuid REFERENCES professionals(id) ON DELETE CASCADE,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  reason          text,
  CONSTRAINT time_off_valid CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS time_off_range_idx ON time_off (starts_at, ends_at);
```

`professional_id` nullable significa regla global del negocio; con valor, override
por profesional.

## 4.6 Conversaciones y mensajes

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_identity_id  uuid NOT NULL REFERENCES channel_identities(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','idle','closed','handoff')),
  summary              text,
  llm_provider         text NOT NULL DEFAULT 'anthropic',
  llm_model            text,
  last_message_at      timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_active_idx
  ON conversations (channel_identity_id)
  WHERE status IN ('active', 'handoff');
```

Ese índice único parcial **garantiza a nivel de BD que un usuario no puede tener
dos conversaciones activas**. Sin él, dos mensajes concurrentes crean dos hilos y
el agente desarrolla amnesia. Con él, el segundo insert falla y se hace fallback
al hilo existente.

`llm_provider` implementa el **pinning de proveedor por conversación**. Es la
simplificación que hace la agnosticidad barata: existe la tentación de hacer el
historial perfectamente portable para poder cambiar de proveedor a media
conversación, pero eso consume el 80% del esfuerzo para resolver un caso que no
ocurre. Las conversaciones aquí son cortas y con propósito: cinco o diez turnos,
minutos u horas. Una conversación empieza con un proveedor y **termina con ese
proveedor**. Cambiar de proveedor es cambiar el default: las nuevas usan el nuevo,
las vivas terminan con el viejo, y en unas horas la migración se hace sola.

Efecto secundario útil: habilita A/B testing real. Enviar 10% de conversaciones
nuevas a otro proveedor y comparar tasa de reserva.

```sql
CREATE TABLE IF NOT EXISTS messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq                  bigserial NOT NULL,
  role                 text NOT NULL CHECK (role IN ('user', 'assistant')),
  blocks               jsonb NOT NULL CHECK (jsonb_typeof(blocks) = 'array'),
  tool_names           text[] NOT NULL DEFAULT '{}',
  provider_message_id  text,
  llm_provider         text,
  llm_model            text,
  provider_raw         jsonb,
  system_prompt_hash   text,
  latency_ms           int,
  input_tokens         int,
  output_tokens        int,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_id_idx
  ON messages (provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_conversation_seq_idx
  ON messages (conversation_id, seq DESC);

CREATE INDEX IF NOT EXISTS messages_tool_names_idx
  ON messages USING gin (tool_names);
```

Decisiones a destacar, porque no son obvias:

- **`role` solo admite `user` y `assistant`.** No existe `'tool'`. Esto parece
  raro viniendo de OpenAI, pero es lo correcto: Anthropic mete los resultados de
  tools dentro de un mensaje de rol `user` y Gemini usa un `parts[]` propio. Si se
  canoniza `role: 'tool'`, se está copiando la forma de OpenAI y todo adaptador
  que no sea OpenAI tendrá que hacer ingeniería inversa. Los resultados de tools
  son **bloques**, no roles.
- **`blocks jsonb`** guarda el `ContentBlock[]` canónico de la Fase 5 tal cual.
- **`tool_names text[]`** es desnormalización deliberada. Consultar dentro del
  `jsonb` para responder "¿cuántas veces se llamó `book_appointment` esta
  semana?" es incómodo; un array con índice GIN lo hace trivial.
- **No se guarda el system prompt** como mensaje, porque se reconstruye en cada
  turno con la fecha actual y el catálogo vivo. Guardarlo sería guardar datos
  caducos. `system_prompt_hash` permite depurar qué versión se usó.
- **`input_tokens` / `output_tokens`**, no `prompt_tokens` / `completion_tokens`,
  que era nomenclatura de OpenAI. Anthropic usa input/output y Gemini
  `promptTokenCount`/`candidatesTokenCount`; el nombre neutro sobrevive al cambio.
- **`provider_raw`** guarda los blobs opacos (bloques de razonamiento con firma
  criptográfica en Anthropic, items de reasoning cifrados en OpenAI) que **deben
  reenviarse intactos** en las siguientes vueltas. No son canonizables. Cada
  adaptador reenvía los suyos e ignora los ajenos.
- **`seq bigserial`** en lugar de ordenar por `created_at`. Dos mensajes en el
  mismo milisegundo ordenan de forma no determinista, y reconstruir el historial
  de un agente en orden equivocado produce respuestas incoherentes.

## 4.7 `slot_offers`: la pieza central del diseño

Esto convierte "por favor verifica disponibilidad primero" de instrucción blanda
a **invariante del sistema**.

```sql
CREATE TABLE IF NOT EXISTS slot_offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token            text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  professional_id  uuid NOT NULL REFERENCES professionals(id),
  service_id       uuid NOT NULL REFERENCES services(id),
  start_time       timestamptz NOT NULL,
  end_time         timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  consumed_at      timestamptz,
  consumed_by_appt uuid REFERENCES appointments(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS slot_offers_lookup_idx
  ON slot_offers (token) WHERE consumed_at IS NULL;
```

`check_availability` inserta una fila por cada hueco que ofrece y devuelve los
tokens al LLM. `book_appointment` solo acepta un token; lo valida (existe, no
consumido, no expirado, pertenece a esta conversación) y lo marca consumido en la
misma transacción que crea la cita.

Consecuencia: **el LLM no puede reservar un horario inventado.** No tiene forma
de fabricar un token válido. Alucinar deja de ser un riesgo de negocio y se
convierte en un error controlado. El `expires_at` además da caducidad natural: si
el usuario tarda 40 minutos en contestar, el token murió y el agente re-verifica,
que es exactamente el comportamiento correcto.

## 4.8 Corregir la carrera y extender `appointments` (Blocker 2)

```sql
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES services(id),
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id),
  ADD COLUMN IF NOT EXISTS source_channel channel_type,
  ADD COLUMN IF NOT EXISTS google_event_id text,
  ADD COLUMN IF NOT EXISTS google_sync_status text NOT NULL DEFAULT 'pending'
      CHECK (google_sync_status IN ('pending','synced','failed','not_required')),
  ADD COLUMN IF NOT EXISTS google_sync_error text,
  ADD COLUMN IF NOT EXISTS google_sync_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS google_synced_at timestamptz;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_valid_range CHECK (end_time > start_time);

ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    professional_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status IN ('scheduled', 'confirmed'));

CREATE INDEX IF NOT EXISTS appointments_google_sync_idx
  ON appointments (google_sync_status)
  WHERE google_sync_status IN ('pending', 'failed');
```

La constraint de exclusión es la corrección más importante de la migración. El
doble booking pasa a ser **imposible** a nivel de motor, sin importar cuántos
turnos concurrentes corran. El `COUNT(*)` de `fn_book_appointment` queda como
fast-path amable (para dar buen mensaje de error), no como garantía.

El intervalo `'[)'` es semiabierto: una cita que acaba a las 15:00 y otra que
empieza a las 15:00 **no** se solapan, que es el comportamiento deseado.

## 4.9 `fn_book_appointment_v2`

```sql
CREATE OR REPLACE FUNCTION fn_book_appointment_v2(
  p_slot_token       text,
  p_conversation_id  uuid,
  p_client_id        uuid,
  p_source_channel   channel_type,
  p_notes            text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_offer  slot_offers;
  v_appt   appointments;
BEGIN
  SELECT * INTO v_offer
  FROM slot_offers
  WHERE token = p_slot_token
    AND conversation_id = p_conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_SLOT_TOKEN');
  END IF;

  IF v_offer.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SLOT_ALREADY_BOOKED');
  END IF;

  IF v_offer.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SLOT_EXPIRED');
  END IF;

  BEGIN
    INSERT INTO appointments (
      client_id, professional_id, service_id, conversation_id,
      source_channel, start_time, end_time, status, notes
    ) VALUES (
      p_client_id, v_offer.professional_id, v_offer.service_id, p_conversation_id,
      p_source_channel, v_offer.start_time, v_offer.end_time, 'scheduled', p_notes
    )
    RETURNING * INTO v_appt;
  EXCEPTION
    WHEN exclusion_violation THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SLOT_CONFLICT');
  END;

  UPDATE slot_offers
  SET consumed_at = now(), consumed_by_appt = v_appt.id
  WHERE id = v_offer.id;

  RETURN jsonb_build_object('ok', true, 'appointment', to_jsonb(v_appt));
END;
$$;
```

Nótese que **devuelve códigos en lugar de lanzar excepciones** para los fallos
esperables. Es deliberado: cada código se traduce a un mensaje distinto que el
LLM sabe manejar. `SLOT_EXPIRED` → "se me venció la reserva, déjame
reconfirmar". `SLOT_CONFLICT` → "justo alguien lo tomó, te ofrezco otro". Un
error genérico obligaría al modelo a adivinar.

## 4.10 Row Level Security

`agent-core` usa la service role key, que hace bypass de RLS. Lo crítico es que
nadie más pueda tocar estas tablas con la anon key:

```sql
ALTER TABLE channel_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE slot_offers        ENABLE ROW LEVEL SECURITY;
```

Sin políticas y con RLS activo, la anon key no ve nada. Es lo correcto: son datos
personales de conversaciones. Y la service role key **solo** debe vivir en
`agent-core`, nunca en n8n de forma que un Code node arbitrario la use.

---

# Fase 5 — TypeScript, Zod y el puerto LLM

## 5.1 Estructura

```
agent-core/
├── Dockerfile
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                 # servidor HTTP, auth de n8n
    ├── config.ts                # env validado con Zod al arrancar
    ├── domain/
    │   ├── channel.ts           # evento canónico entrante
    │   └── errors.ts            # AppError, códigos
    ├── llm/
    │   ├── port.ts              # tipos canónicos + interface LlmProvider
    │   ├── registry.ts          # provider por id
    │   ├── loop.ts              # EL BUCLE
    │   ├── prompt.ts            # system prompt dinámico
    │   ├── tools.ts             # Zod → ToolSpec[]
    │   ├── schema/
    │   │   └── downgrade.ts     # recortes de JSON Schema por dialecto
    │   └── providers/
    │       ├── anthropic.ts
    │       ├── gemini.ts
    │       ├── openai.ts
    │       └── fake.ts          # tests deterministas
    ├── tools/
    │   ├── registry.ts
    │   ├── checkAvailability.ts
    │   ├── bookAppointment.ts
    │   ├── rescheduleAppointment.ts
    │   ├── cancelAppointment.ts
    │   └── listMyAppointments.ts
    ├── db/
    │   ├── pool.ts              # pg, para advisory locks y RPC
    │   ├── conversations.ts
    │   └── identities.ts
    ├── calendar/
    │   └── google.ts
    └── util/
        ├── time.ts              # luxon, todo el manejo de zonas
        └── logger.ts
```

`tsconfig.json` en modo estricto de verdad:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

`noUncheckedIndexedAccess` obliga a manejar `blocks[0]` posiblemente undefined,
que es exactamente el caso que rompe cuando el LLM devuelve un array vacío.

## 5.2 Validar el entorno al arrancar

Fallar en el arranque, no en el primer mensaje del usuario:

```ts
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  AGENT_CORE_TOKEN: z.string().min(32),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_DB_URL: z.string().startsWith('postgres'),
  LLM_DEFAULT_PROVIDER: z.enum(['anthropic', 'gemini', 'openai']).default('anthropic'),
  LLM_DEFAULT_MODEL: z.string().min(1),
  LLM_FALLBACK_PROVIDER: z.enum(['anthropic', 'gemini', 'openai']).optional(),
  ANTHROPIC_API_KEY: z.string().min(10).optional(),
  GEMINI_API_KEY: z.string().min(10).optional(),
  OPENAI_API_KEY: z.string().min(10).optional(),
  BUSINESS_TIMEZONE: z.string().default('America/Bogota'),
  GOOGLE_CALENDAR_ID: z.string().optional(),
  GOOGLE_SA_JSON: z.string().optional(),
  MAX_TOOL_ITERATIONS: z.coerce.number().int().min(1).max(10).default(6),
}).superRefine((env, ctx) => {
  const keyOf = {
    anthropic: env.ANTHROPIC_API_KEY,
    gemini: env.GEMINI_API_KEY,
    openai: env.OPENAI_API_KEY,
  } as const;

  for (const p of [env.LLM_DEFAULT_PROVIDER, env.LLM_FALLBACK_PROVIDER]) {
    if (p && !keyOf[p]) {
      ctx.addIssue({ code: 'custom', message: `Falta la API key del proveedor "${p}"` });
    }
  }
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Configuración inválida:', z.treeifyError(parsed.error));
  process.exit(1);
}
export const config = Object.freeze(parsed.data);
```

Sin el `superRefine`, arrancar con `LLM_DEFAULT_PROVIDER=gemini` y sin
`GEMINI_API_KEY` produce un fallo en el primer mensaje de un usuario real.

## 5.3 El puerto LLM

```ts
// src/llm/port.ts

export type ProviderId = 'anthropic' | 'gemini' | 'openai' | 'fake';

export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; callId: string; toolName: string; input: unknown }
  | { kind: 'tool_result'; callId: string; toolName: string; output: unknown; isError: boolean }
  | { kind: 'opaque'; provider: ProviderId; payload: unknown };

export interface CanonicalMessage {
  role: 'user' | 'assistant';
  blocks: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
}

export interface CompletionRequest {
  system: string;
  messages: CanonicalMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  temperature?: number;
  toolChoice?: 'auto' | 'required' | 'none';
}

export type StopReason =
  | 'tool_call' | 'end_turn' | 'max_tokens' | 'content_filtered' | 'other';

export interface CompletionResponse {
  message: CanonicalMessage;
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmProvider {
  readonly id: ProviderId;
  complete(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResponse>;
}
```

Un puerto con **un solo método** es una abstracción honesta. Un puerto con veinte
es un framework del que uno se arrepiente. Añadir métodos solo bajo demanda real;
cada uno hay que implementarlo tres veces.

### Las dos decisiones de modelado que hacen que los tres proveedores encajen

**1. `role` solo admite `user` y `assistant`, y `tool_result` es un bloque.**
OpenAI tiene `role: "tool"`; Anthropic mete los resultados en un mensaje `user`;
Gemini usa `role: "function"` en un `parts[]`. Canonizando `role: 'tool'` se copia
la forma de OpenAI y el adaptador de Anthropic tendría que reagrupar por
ingeniería inversa. Como bloque, **cada adaptador decide dónde colocarlo**.

**2. `input` es `unknown` ya parseado, no `string`.** OpenAI devuelve los
argumentos como string de JSON; Anthropic y Gemini como objeto. Canonizando
`arguments: string` se obliga a los otros dos a re-serializar para que el bucle
vuelva a parsear. El `JSON.parse` pertenece al adaptador de OpenAI.

Estas dos son exactamente el tipo de fuga que se cuela cuando se escribe el
"puerto agnóstico" mirando un solo proveedor.

## 5.4 Dónde fuga de verdad

| Diferencia | Coste |
|---|---|
| `system` en el array vs. parámetro top-level | Trivial |
| `assistant` vs. `model` como nombre de rol | Trivial |
| `parameters` vs. `input_schema` vs. `functionDeclarations` | Trivial |
| Nombres de campos de usage y stop reason | Trivial |
| Gemini no tiene IDs de tool call | Medio |
| Dialectos de JSON Schema incompatibles | Medio |
| Bloques de razonamiento opacos | Alto, evitable |
| Prompt caching | Alto, es coste no complejidad |

### Gemini no tiene `tool_call_id`

OpenAI y Anthropic emparejan cada resultado con su llamada por ID. Gemini
empareja **por nombre de función**, sin ID. Si el modelo llama
`check_availability` dos veces en paralelo (dos fechas), no hay forma canónica de
saber qué respuesta corresponde a cuál.

El adaptador de Gemini sintetiza IDs por posición (`check_availability#0`, `#1`) y
garantiza emitir los `functionResponse` **en el mismo orden** en que llegaron los
`functionCall`. Son ~20 líneas, pero hay que cubrirlas con un test porque falla
silenciosamente y de forma rarísima: el agente ofrece los huecos del martes
cuando el usuario preguntó por el miércoles.

### Los dialectos de JSON Schema

Los tres aceptan "JSON Schema", pero subconjuntos distintos:

- **Gemini**: subconjunto de OpenAPI 3.0. Sin `$ref`, soporte pobre de `anyOf`,
  `enum` solo en strings, usa `nullable: true`.
- **OpenAI en modo `strict`**: exige que *todas* las propiedades estén en
  `required` y `additionalProperties: false`; ignora o rechaza `pattern`,
  `minLength`, `format`. Los opcionales se expresan como unión con `null`.
- **Anthropic**: el más permisivo, digiere JSON Schema moderno casi completo.

**Este problema casi no afecta, porque Zod es el validador real, no el schema del
wire.** El JSON Schema que se manda al modelo es una *sugerencia*; el Zod que
corre en el contenedor es la *garantía*. Que Gemini ignore
`pattern: "^\\d{4}-\\d{2}-\\d{2}$"` no importa: cuando el modelo mande `"mañana"`
en lugar de `"2026-08-21"`, `safeParse` lo rechaza y se le devuelve el error para
que se autocorrija.

Regla: schemas ricos en Zod, y cada adaptador con una función `downgradeSchema()`
que recorta lo que su proveedor no soporta (~30 líneas por adaptador).

Corolario importante: **no hacer que la corrección dependa del modo `strict` de
OpenAI.** Reduce errores y se puede activar cuando el proveedor es OpenAI, pero si
se diseña asumiéndolo, el día que se pruebe Gemini el agente se degrada de forma
inexplicable.

### Los bloques de razonamiento

Los modelos de razonamiento producen contenido que **debe devolverse intacto** en
las siguientes vueltas: Anthropic exige reenviar los `thinking` blocks con su
firma criptográfica; OpenAI tiene items de reasoning cifrados. No son
intercambiables ni inspeccionables, y descartarlos degrada calidad o produce
errores de API.

No intentar canonizarlos: `kind: 'opaque'` etiquetado con su proveedor, guardado
en `messages.provider_raw`, y cada adaptador reenvía los suyos e ignora los
ajenos. El pinning por conversación (Fase 4.6) hace que esto nunca sea un
problema real.

### Prompt caching

Cada proveedor lo hace distinto: Anthropic requiere breakpoints explícitos,
Gemini tiene context caching explícito, OpenAI lo hace automático. El system
prompt con catálogo y horarios es grande y estable — exactamente lo que conviene
cachear, con ahorros del orden del 70-90% en tokens de entrada. Un puerto ingenuo
lo pierde.

Solución: un campo `cacheHints` opcional en `CompletionRequest` que cada
adaptador aplica como pueda y los demás ignoran. Feo, pero el ahorro es demasiado
grande para renunciar a él.

## 5.5 Tools: Zod como única fuente de verdad

El error habitual es escribir el JSON Schema para el LLM **y además** un tipo
TypeScript. Se desincronizan y aparecen bugs silenciosos. Se define en Zod y se
deriva el schema.

```ts
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa formato YYYY-MM-DD');

export const CheckAvailabilityArgs = z.object({
  service_slug: z.string().min(1)
    .describe('Slug del servicio. DEBE ser uno de la lista del system prompt.'),
  date: IsoDate
    .describe('Fecha a consultar. Resuelve "mañana"/"el viernes" a fecha absoluta.'),
  preferred_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()
    .describe('Hora preferida HH:mm 24h en zona del negocio. Omitir si no la dijo.'),
  professional_name: z.string().optional()
    .describe('Solo si el usuario pidió un profesional concreto.'),
}).strict();

export const BookAppointmentArgs = z.object({
  slot_token: z.string().min(8)
    .describe('OBLIGATORIO. Token devuelto por check_availability. NUNCA lo inventes.'),
  client_full_name: z.string().min(2)
    .describe('Nombre completo. Pídelo al usuario si no lo sabes.'),
  notes: z.string().max(500).optional(),
}).strict();
```

Dos cosas fáciles de subestimar:

- **`.strict()`** rechaza claves extra. Los LLM añaden campos que nadie pidió
  (`"confirmed": true`). Sin `.strict()` pasan silenciosamente al resto del
  sistema.
- **`.describe()` no es documentación, es prompt.** El texto va al JSON Schema y
  el modelo lo lee. `"NUNCA lo inventes"` en la descripción del `slot_token`
  reduce alucinaciones de forma medible. Es el sitio de mayor retorno por palabra
  escrita del proyecto.

Y la conversión a `ToolSpec[]` neutro, una sola vez:

```ts
export type ToolName =
  | 'check_availability' | 'book_appointment' | 'reschedule_appointment'
  | 'cancel_appointment' | 'list_my_appointments' | 'request_human_handoff';

const SCHEMAS = {
  check_availability: CheckAvailabilityArgs,
  book_appointment: BookAppointmentArgs,
  // ...
} as const satisfies Record<ToolName, z.ZodTypeAny>;

export const TOOL_SPECS: ToolSpec[] = Object.entries(SCHEMAS).map(([name, schema]) => ({
  name,
  description: DESCRIPTIONS[name as ToolName],
  inputSchema: zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }),
}));
```

`$refStrategy: 'none'` es obligatorio en la práctica: las APIs de LLM no manejan
bien `$ref`/`$defs` y los schemas con referencias fallan de forma opaca.

## 5.6 Devolver los errores de validación al modelo

El corazón de por qué no hace falta LangChain. Cuando Zod falla, no se revienta:
se le explica al modelo qué hizo mal.

```ts
type ToolOutcome =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string; hint?: string };

export async function executeTool(
  name: string,
  input: unknown,          // ya parseado por el adaptador
  ctx: TurnContext
): Promise<ToolOutcome> {
  const schema = SCHEMAS[name as ToolName];
  if (!schema) {
    return { ok: false, code: 'UNKNOWN_TOOL',
             message: `La herramienta "${name}" no existe.`,
             hint: `Disponibles: ${Object.keys(SCHEMAS).join(', ')}` };
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('; ');
    return { ok: false, code: 'VALIDATION_ERROR',
             message: `Argumentos inválidos: ${issues}`,
             hint: 'Corrige los campos y vuelve a llamar la herramienta.' };
  }

  try {
    const data = await HANDLERS[name as ToolName](parsed.data as never, ctx);
    return { ok: true, data };
  } catch (err) {
    ctx.logger.error({ err, tool: name }, 'tool execution failed');
    // El modelo NUNCA ve stack traces ni detalles internos.
    return { ok: false, code: 'INTERNAL_ERROR',
             message: 'Fallo temporal ejecutando la operación.',
             hint: 'Discúlpate y sugiere reintentar en un momento.' };
  }
}
```

El último `catch` es importante: el modelo recibe un mensaje genérico, nunca el
error interno. Filtrar excepciones al prompt es una fuga de información — el
modelo repetirá al usuario el string de conexión si aparece en el mensaje.

## 5.7 El bucle

Las ~60 líneas que reemplazan a LangChain:

```ts
export async function runTurn(ctx: TurnContext): Promise<string> {
  const provider = getProvider(ctx.conversation.llmProvider);
  const system = await buildSystemPrompt(ctx);
  const messages: CanonicalMessage[] = [
    ...(await loadHistory(ctx.conversationId, 20)),
    { role: 'user', blocks: [{ kind: 'text', text: ctx.userText }] },
  ];

  for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
    const res = await provider.complete({
      system,
      messages,
      tools: TOOL_SPECS,
      maxOutputTokens: 1024,
      toolChoice: 'auto',
    }, ctx.signal);

    messages.push(res.message);

    const calls = res.message.blocks.filter(
      (b): b is Extract<ContentBlock, { kind: 'tool_call' }> => b.kind === 'tool_call'
    );

    if (calls.length === 0) {
      const text = res.message.blocks
        .flatMap(b => (b.kind === 'text' ? [b.text] : []))
        .join('\n').trim();
      if (!text) throw new AppError('EMPTY_COMPLETION');
      await persistTurn(ctx, messages, res.usage);
      return text;
    }

    // Paralelo: el modelo puede pedir varias tools en un turno.
    const resultBlocks: ContentBlock[] = await Promise.all(
      calls.map(async (call) => {
        const outcome = await executeTool(call.toolName, call.input, ctx);
        return {
          kind: 'tool_result' as const,
          callId: call.callId,
          toolName: call.toolName,
          output: outcome,
          isError: !outcome.ok,
        };
      })
    );

    messages.push({ role: 'user', blocks: resultBlocks });
  }

  // Iteraciones agotadas: degradación elegante, no un crash.
  await persistTurn(ctx, messages);
  await flagForHumanReview(ctx, 'max_iterations_exceeded');
  return 'Disculpa, estoy teniendo problemas para procesar tu solicitud. ' +
         'Un miembro del equipo te contactará en breve.';
}
```

Detalles que importan:

- **`for` acotado, no `while (true)`.** Un bucle sin límite es un incidente de
  facturación esperando a ocurrir.
- **`Promise.all`** porque los modelos modernos piden varias tools en un turno, y
  ejecutarlas en serie duplica la latencia.
- **Cada `tool_call` debe recibir su `tool_result`.** Si falta uno, la API rechaza
  la siguiente petición por historial malformado.
- **`maxOutputTokens` explícito.** Anthropic lo exige, y darle un valor a los tres
  es mejor que depender de defaults distintos.
- Los resultados van en un mensaje `role: 'user'` con bloques `tool_result`. Cada
  adaptador lo traduce a su forma nativa.

## 5.8 Tiempo: la fuente número uno de bugs

Regla absoluta: **UTC en la base de datos, zona del negocio solo en los bordes.**
Usar Luxon, no `Date` nativo.

```ts
import { DateTime } from 'luxon';

export function businessNow(tz: string): DateTime {
  return DateTime.now().setZone(tz);
}

/** "2026-08-20" + "15:00" en zona negocio → instante UTC. */
export function toUtcInstant(date: string, time: string, tz: string): Date {
  const dt = DateTime.fromFormat(`${date} ${time}`, 'yyyy-MM-dd HH:mm', { zone: tz });
  if (!dt.isValid) throw new AppError('INVALID_DATETIME', dt.invalidReason ?? '');
  return dt.toUTC().toJSDate();
}

/** Para el prompt: fecha legible con día de semana, en español. */
export function humanNow(tz: string, locale = 'es'): string {
  return businessNow(tz).setLocale(locale)
    .toFormat("cccc d 'de' LLLL 'de' yyyy, HH:mm");
}
```

El caso que muerde: en zonas con horario de verano, `toUtcInstant` puede recibir
una hora **que no existe** (salto de primavera) o **que existe dos veces** (salto
de otoño). Luxon lo señala en `isValid`/`invalidReason` en el primer caso.
Operando solo en Colombia (sin DST) esto es teórico; el día que se abra sucursal
en Chile o España deja de serlo.

En el system prompt, inyectar siempre `humanNow()`.

## 5.9 El `FakeProvider`

En cuanto existe el puerto, se puede escribir un provider que devuelve tool calls
con guion. Con eso se testea **todo el bucle, las tools y los casos extremos** de
forma determinista, sin gastar nada y sin flakiness.

Probar el caso `SLOT_CONFLICT` con un LLM real es una pesadilla; con un fake es
un test unitario de diez líneas. El puerto se justifica solo por esto, incluso
asumiendo que nunca se cambie de proveedor.

## 5.10 Contract tests

Lo que hace que la agnosticidad sea real y no aspiracional:

**Implementar dos proveedores desde el principio, no uno.** Una abstracción
escrita contra un solo proveedor no es una abstracción, es un wrapper con nombre
pretencioso. El segundo adaptador es el que descubre las fugas. Construyendo solo
OpenAI ahora y "añadiendo Anthropic más adelante", el tipo canónico acaba con
supuestos de OpenAI incrustados en veinte sitios.

Primer par recomendado: **Anthropic + Gemini**. Es el par más *distinto* (bloques
de contenido vs. `parts`, IDs vs. sin IDs, schema permisivo vs. restrictivo). Si
el puerto los soporta a ambos, OpenAI entra en una tarde. Empezando por
OpenAI + Anthropic, que son parecidos, Gemini rompe el diseño después.

**Una suite de contract tests que corre contra los tres**, con las mismas
aserciones por adaptador:

- Un tool call simple se traduce ida y vuelta sin perder información.
- Dos tool calls en paralelo mantienen el emparejamiento call↔result.
- Un `tool_result` con `isError: true` llega al modelo.
- Un historial con tool calls previas se reconstruye correctamente.
- Un bloque `opaque` de otro proveedor se ignora sin romper.

Sin esto, "somos agnósticos" es una afirmación sin evidencia.

---

# Fase 6 — Configuración de n8n

Esta fase es **idéntica** con o sin agnosticismo: n8n nunca sabe qué LLM se usa.
Es la mejor señal de que la separación de la Fase 1 es correcta.

## 6.1 Seis workflows, no tres monolitos

La tentación es un workflow gigante por canal. Triplica la lógica de envío y de
errores.

| Workflow | Tipo | Función |
|---|---|---|
| `Ingress - WhatsApp` | Webhook | Verificar firma, normalizar, dedup |
| `Ingress - Instagram` | Webhook | Igual, envelope distinto |
| `Ingress - Telegram` | Telegram Trigger | Nodo nativo |
| `Agent Turn` | Sub-workflow | Llamar a `agent-core` (compartido) |
| `Egress - Send Message` | Sub-workflow | Switch por canal, envío |
| `Cron - Calendar Reconcile` | Schedule | Reintentar syncs pendientes |

Más los workflows existentes de recordatorios y error handler global, que siguen
funcionando sin tocarlos.

## 6.2 `Ingress - WhatsApp`, nodo por nodo

**1. Webhook (GET).** Path `whatsapp`, método GET, Response Mode *Using Respond
to Webhook node*. Meta hace un handshake antes de activar la suscripción.

**2. Code: verificar el challenge.**

```js
const q = $input.first().json.query ?? {};
if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === $env.META_VERIFY_TOKEN) {
  return [{ json: { challenge: q['hub.challenge'] } }];
}
throw new Error('Verificación de webhook fallida');
```

**3. Respond to Webhook.** Devolver el `challenge` como **texto plano**, no JSON.
Meta rechaza el handshake si se responde `{"challenge":"..."}` en lugar de
`1158201444`. Es el error más común del setup de Meta.

**4. Webhook (POST).** Mismo path `whatsapp`, método POST. Activar la opción
**Raw Body**: es necesaria para el HMAC.

**5. Respond to Webhook: 200 vacío inmediato.** Antes de cualquier
procesamiento.

**6. Code: verificar firma HMAC.**

```js
const crypto = require('crypto');
const item = $input.first();
const raw = item.binary?.data
  ? Buffer.from(item.binary.data.data, 'base64')
  : Buffer.from(item.json.body ?? '', 'utf8');

const header = item.json.headers['x-hub-signature-256'] ?? '';
const expected = 'sha256=' + crypto
  .createHmac('sha256', $env.META_APP_SECRET)
  .update(raw)
  .digest('hex');

const a = Buffer.from(header);
const b = Buffer.from(expected);
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
  throw new Error('Firma de webhook inválida');
}
return [{ json: JSON.parse(raw.toString('utf8')) }];
```

`timingSafeEqual` en lugar de `===` evita ataques de temporización. Es una línea.

**7. Code: normalizar.** Aplanar el envelope y filtrar lo que no es mensaje de
usuario (statuses de entrega, reacciones, ecos):

```js
const out = [];
for (const entry of $input.first().json.entry ?? []) {
  for (const change of entry.changes ?? []) {
    const v = change.value ?? {};
    if (!v.messages?.length) continue;           // status update, no mensaje
    const profile = v.contacts?.[0]?.profile ?? {};
    for (const m of v.messages) {
      out.push({ json: {
        channel: 'whatsapp',
        external_user_id: m.from,
        provider_message_id: m.id,
        display_name: profile.name ?? null,
        message_type: m.type,
        text: m.type === 'text' ? m.text.body : null,
        received_at: new Date(Number(m.timestamp) * 1000).toISOString(),
      }});
    }
  }
}
return out;
```

Preservar `message_type` importa: los usuarios mandan notas de voz, stickers y
ubicaciones, y hay que detectarlo para responder con elegancia en vez de pasar
`null` al LLM.

**8. Switch por `message_type`.** Rama `text` → sigue al agente. Otras →
respuesta fija ("Por ahora solo puedo leer texto, ¿me escribes tu solicitud?").

**9. Execute Workflow → `Agent Turn`.**

**10. Execute Workflow → `Egress - Send Message`.**

## 6.3 `Ingress - Instagram`

Estructura idéntica, con cuatro diferencias: `object: "instagram"`, el payload usa
`entry[].messaging[]` (estilo Messenger) en vez de `changes[].value.messages[]`,
el `external_user_id` es un IGSID opaco (no un teléfono), y **hay que filtrar los
ecos** (`message.is_echo`) o el bot se responderá a sí mismo en bucle infinito.

## 6.4 `Ingress - Telegram`

El más fácil: nodo **Telegram Trigger** nativo, evento *Message*. Configurar el
`secret_token` al registrar el webhook y verificarlo contra la cabecera
`X-Telegram-Bot-Api-Secret-Token`. Es el equivalente de Telegram al HMAC de Meta
y mucha gente lo omite, dejando el endpoint abierto.

Telegram también regala `sendChatAction` con `typing`. Dispararlo antes del turno:
15 segundos de silencio se sienten como un bot roto; con el indicador de escritura
se sienten como alguien pensando.

## 6.5 `Agent Turn`

**Execute Workflow Trigger** → **HTTP Request**:

- URL: `{{ $env.AGENT_CORE_URL }}/v1/agent/turn`
- POST, header `Authorization: Bearer {{ $env.AGENT_CORE_TOKEN }}`
- Body: el evento canónico
- **Timeout: 60000 ms.** El default de n8n es demasiado corto para varias tool
  calls; los timeouts se manifiestan como fallos aleatorios difíciles de
  diagnosticar.
- **Retry On Fail: 2 intentos, 2000 ms.** Es seguro porque la dedup por
  `provider_message_id` hace el endpoint idempotente.
- **On Error: Continue (using error output).** Conectar esa salida a un nodo Set
  con un mensaje de disculpa y de ahí a Egress. Un fallo del LLM produce una
  respuesta amable en lugar de silencio. El silencio es la peor UX posible: el
  usuario reescribe, se frustra y se va.

## 6.6 `Egress - Send Message`

**Switch** sobre `{{ $json.channel }}` con tres ramas:

- **WhatsApp:** POST a
  `https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_NUMBER_ID }}/messages`,
  body `{ messaging_product: "whatsapp", to, type: "text", text: { body } }`.
- **Instagram:** POST a `/v21.0/me/messages` con
  `{ recipient: { id }, message: { text } }`.
- **Telegram:** nodo nativo Telegram → Send Message.

Antes del Switch, un Code node que **parta mensajes largos**: WhatsApp corta en
4096 caracteres, Instagram en 1000. Un mensaje truncado a mitad de frase parece
un bug, y lo es.

## 6.7 Ajustes de n8n que cuestan horas si se ignoran

- **Publicar el workflow.** Las URLs `/webhook/` solo existen si el workflow está
  publicado. `/webhook-test/` solo funciona con el editor abierto y **solo para
  una ejecución**.
- **Concurrencia.** *Settings → Concurrency*: limitar ejecuciones simultáneas. Sin
  límite, un pico de tráfico abre 200 turnos de LLM en paralelo. El advisory lock
  protege la corrección de datos; el límite de concurrencia protege la factura.
- **Error Workflow.** En los settings de cada workflow nuevo, asignar el
  `Error Handler (Global)` de la v1. La Dead Letter Queue ya está construida.

---

# Fase 7 — Manejo de casos extremos

## 7.1 El usuario pide una hora ya ocupada

No se le pide a la IA que verifique primero: **se le impone.** Tres capas, de la
más débil a la más fuerte:

1. **Prompt** (blanda, ~85% efectiva): "NUNCA confirmes una cita sin llamar antes
   a `check_availability`."
2. **Diseño del schema** (media): `book_appointment` requiere `slot_token`, y su
   `.describe()` dice explícitamente que solo viene de `check_availability`.
3. **Imposición en BD** (dura, 100%): `fn_book_appointment_v2` valida el token
   contra `slot_offers`. Sin token válido, no hay cita.

Solo la capa 3 es una garantía. Las otras dos reducen reintentos, pero la
corrección no depende de que el modelo se porte bien.

Cuando el hueco no está disponible, la tool no devuelve un simple "no". Devuelve
alternativas listas para ofrecer:

```json
{
  "ok": true,
  "requested_slot_available": false,
  "reason": "El horario 15:00 ya está reservado",
  "alternatives": [
    { "slot_token": "a3f9...", "start_local": "2026-08-20 14:30", "professional": "Ana" },
    { "slot_token": "b7c2...", "start_local": "2026-08-20 16:00", "professional": "Ana" },
    { "slot_token": "c1d8...", "start_local": "2026-08-21 15:00", "professional": "Ana" }
  ],
  "instruction_for_assistant": "Informa que el horario pedido no está libre y ofrece estas 3 opciones de forma natural. No inventes otros horarios."
}
```

El `instruction_for_assistant` dentro del resultado de la tool es una técnica poco
usada y muy efectiva: guía el comportamiento **en el punto de decisión**, con
contexto fresco, en vez de esperar que el modelo recuerde una regla del system
prompt 15 mensajes atrás.

Máximo 3 alternativas. Con 12 opciones el modelo las lista todas y produce un
muro de texto ilegible en WhatsApp.

## 7.2 Carrera perdida entre la oferta y la confirmación

Ventana real: `check_availability` a las 15:00:03, el usuario responde "sí" a las
15:02:41. En esos dos minutos otro cliente puede tomar el hueco.

La constraint de exclusión lo detecta, la RPC devuelve `SLOT_CONFLICT`, y **no se
falla**: dentro del mismo turno se vuelve a llamar a `check_availability`
internamente y se devuelve al modelo el conflicto **junto con nuevas
alternativas**. El modelo produce: *"Justo acaban de tomar las 4. Tengo 4:30 o 5,
¿te sirve alguna?"*

El usuario percibe una recuperación fluida y ningún dato se corrompió. Esto es el
bucle autocorrigiéndose, y es la mejor demostración de por qué debe vivir en
TypeScript: expresar este reintento condicional en nodos de n8n es un infierno.

## 7.3 Fechas ambiguas

"El viernes" ¿este o el próximo? "A las 3" ¿AM o PM? "En dos semanas" ¿desde
cuándo?

El modelo debe desambiguar **preguntando**, no adivinando. Reglas en el prompt: si
dice una hora sin AM/PM y el negocio abre en ambas, preguntar; si dice un día de
semana sin fecha y falta menos de 24h para ese día, confirmar explícitamente
("¿este viernes 21 o el próximo 28?").

Defensa en código: rechazar en Zod cualquier fecha en el pasado o a más de 90
días. Si el modelo calcula `2025-08-20` en lugar de `2026-08-20` (error de año,
sorprendentemente común), la validación lo atrapa y se autocorrige.

## 7.4 Fuera de horario

Si el usuario pide domingo y no se abre domingo, la tool no devuelve una lista
vacía: devuelve el motivo y el siguiente día abierto.

```json
{
  "ok": true,
  "requested_slot_available": false,
  "reason": "CLOSED_ON_DAY",
  "detail": "No atendemos los domingos",
  "next_open_day": "2026-08-24",
  "alternatives": [ "..." ]
}
```

Una lista vacía sin explicación hace que el modelo alucine una razón.

## 7.5 Ráfaga de mensajes

"Hola" / "quiero cita" / "mañana 3pm" en 4 segundos, tres webhooks concurrentes.

- **Advisory lock** (`pg_advisory_xact_lock(hashtext(conversation_id))`):
  serializa los turnos. El segundo espera y ve el historial completo.
- **Debounce** (opcional, muy recomendable): al recibir un mensaje, esperar 2-3
  segundos por si llegan más y procesar el texto concatenado. Reduce coste de LLM
  y produce respuestas mucho mejores, porque el agente ve la intención completa en
  vez de reaccionar a "Hola" y luego contradecirse.

Sin esto el agente parece esquizofrénico: responde tres veces con información
inconsistente.

## 7.6 El modelo alucina un servicio o profesional

Catálogo real en el system prompt, y validación en la tool contra la BD. Si no
existe, devolver la lista válida:

```json
{
  "ok": false,
  "code": "UNKNOWN_SERVICE",
  "message": "No existe el servicio 'corte premium'.",
  "available_services": ["corte", "barba", "corte-barba", "tinte"],
  "hint": "Pregunta al usuario cuál de estos quiere. No inventes servicios."
}
```

El modelo se corrige en la siguiente iteración, normalmente pidiendo aclaración.
Comportamiento correcto sin código especial.

## 7.7 Cancelar o reprogramar: verificación de identidad

Riesgo real: el usuario A no debe poder cancelar la cita del usuario B. **Nunca
aceptar un `appointment_id` que venga del LLM sin verificar propiedad.**

Patrón: `list_my_appointments` filtra por el `client_id` derivado de la
**identidad del canal** (no de nada que diga el modelo) y devuelve
`appointment_ref` opacos, de corta vida, ligados a la conversación.
`cancel_appointment` acepta solo esas refs. Misma filosofía que los slot tokens:
el modelo maneja capabilities, no identificadores globales.

Sobre política: la ventana de cancelación (p.ej. no menos de 2h antes) va en la
RPC, no en el prompt. Un usuario insistente convence a un modelo; no convence a
una constraint.

## 7.8 Fallos de Google Calendar

Resuelto por diseño: Postgres es la verdad, la cita es válida sin Google. El sync
marca `pending`, el cron reintenta con backoff exponencial usando
`google_sync_attempts`, y tras N fallos alerta vía la Dead Letter Queue existente.

**Nunca** decir al usuario "no pude agendar" porque falló Google. Su cita existe.
Decírselo genera una llamada de soporte y una doble reserva.

## 7.9 Fallos del proveedor de LLM

Con el puerto hay salida donde antes había un fallo terminal. En el `catch` del
bucle, si el error es 429 o 5xx, reintentar con `LLM_FALLBACK_PROVIDER`.

Cuidado con un detalle: si ya hay bloques `opaque` de razonamiento en el
historial, **no se puede cambiar de proveedor a media conversación**. En ese caso
reintentar con el mismo proveedor y backoff, y cambiar solo si el turno arranca
limpio.

**`stopReason: 'content_filtered'`.** Los tres proveedores tienen filtros de
seguridad con umbrales distintos, y un usuario enfadado puede dispararlos.
Tratarlo como handoff a humano, no como error: no reintentar, porque volverá a
filtrarse.

## 7.10 Bucles infinitos y control de coste

- `MAX_TOOL_ITERATIONS = 6`, con degradación elegante y flag para humano.
- Límite de historial (20 vueltas). Sin esto, una conversación larga crece hasta
  el límite de contexto y empieza a fallar de golpe.
- **Rate limit por identidad**: N mensajes por hora. Un usuario aburrido (o un
  script) puede quemar cientos de dólares en una noche.
  `channel_identities.is_blocked` es el botón de pánico.
- Registrar `input_tokens`/`output_tokens` desde el día 1. Sin esto no se puede
  responder "¿cuánto cuesta atender un cliente?", que es la primera pregunta del
  negocio.

## 7.11 Handoff a humano

Hace falta una salida. Tool `request_human_handoff` y el estado `handoff` de
`conversations`. Mientras esté en `handoff`, el ingress **descarta** los mensajes
hacia el agente (o los reenvía a un canal de staff) para que el bot no interrumpa
una conversación humana en curso.

Dispararlo cuando: el usuario lo pide, se agotan las iteraciones, se detecta
frustración, `content_filtered`, o la petición sale del dominio (reclamaciones,
precios especiales).

## 7.12 La ventana de 24 horas de WhatsApp

Restricción de plataforma que rompe los recordatorios de la v1 en WhatsApp: **solo
se pueden enviar mensajes libres dentro de 24h del último mensaje del usuario.**
Fuera de esa ventana hace falta una **plantilla pre-aprobada** por Meta.

Impacto directo: el recordatorio de 24h *probablemente* cae fuera de la ventana.
Hay que registrar plantillas de recordatorio en el WhatsApp Manager y que el cron
decida entre mensaje libre o plantilla según `conversations.last_message_at`.
Telegram no tiene esta restricción; Instagram tiene reglas propias.

Esto se planifica antes, no después: la aprobación de plantillas tarda días.

---

# Fase 8 — Orden de implementación

No construir por capas horizontales (toda la BD, luego todo el TS, luego todo
n8n). Construir un **camino vertical delgado** y ensancharlo. Así hay algo
funcionando el día 2 y no el día 20.

| # | Paso | Criterio de "hecho" |
|---|---|---|
| 1 | Migración `0006` | Dos inserts solapados: el segundo falla |
| 2 | Semilla: servicios, 1 profesional, `business_hours` | Query de disponibilidad devuelve huecos |
| 3 | `agent-core` mínimo: `/health`, config, pool | Contenedor healthy en `docker compose ps` |
| 4 | `check_availability` sola, sin LLM | `curl` devuelve huecos y crea `slot_offers` |
| 5 | `port.ts` + `fake.ts` + tests del bucle | Tests verdes: slot ocupado, token expirado, args inválidos, `SLOT_CONFLICT` |
| 6 | Adaptador de Anthropic | Primera conversación real por `curl` |
| 7 | Adaptador de Gemini + contract tests | Los mismos tests pasan con ambos |
| 8 | `book_appointment` + slot tokens | Reserva end-to-end sin canales |
| 9 | Telegram (ingress + egress) | **Primer bot real funcionando** |
| 10 | Google Calendar + cron de reconciliación | Evento aparece; sobrevive a Google caído |
| 11 | WhatsApp (App Review, plantillas) | Mensaje de prueba enviado y recibido |
| 12 | Instagram | Idem, con ecos filtrados |
| 13 | Resto de tools: reprogramar, cancelar, listar | Verificación de identidad probada |
| 14 | Endurecer: rate limits, handoff, debounce, observabilidad | Dashboard de coste por conversación |

Dos hitos merecen comentario:

**Paso 5 antes del paso 6.** Escribir el puerto y el fake *antes* del primer
proveedor real hace que el bucle nazca testeado. Es tentador saltárselo para ver
al agente hablar cuanto antes; el coste de esa impaciencia es depurar el bucle
contra un LLM no determinista.

**Paso 9 es el hito psicológico.** Telegram es el canal más simple: sin App
Review, sin verificación de negocio, sin plantillas. Un bot de Telegram
funcionando de verdad valida toda la arquitectura antes de invertir días en la
burocracia de Meta.

## 8.1 Evals

Como el comportamiento no es portable (Fase 1.2), cambiar de proveedor necesita
validación medible. El diseño basado en tools lo hace fácil y objetivo: no hay que
juzgar prosa, se afirma **comportamiento**.

> Dado el historial "quiero cita para corte mañana a las 3" con las 15:00
> ocupadas, el turno debe llamar `check_availability` con
> `service_slug: "corte"` y fecha resuelta a mañana, y **no** debe llamar
> `book_appointment`.

Veinte escenarios así, corriendo contra el `FakeProvider` para lógica y contra
proveedores reales para comportamiento, convierten el cambio de LLM de acto de fe
a decisión medida. Además cubren gratis los casos de la Fase 7: slot ocupado,
fecha ambigua, fuera de horario, servicio inexistente.

---

# Apéndice A — Inventario de secretos

| Variable | Origen | Notas |
|---|---|---|
| `N8N_ENCRYPTION_KEY` | `openssl rand -hex 32` | **Perderla = perder todas las credenciales de n8n** |
| `N8N_JWT_SECRET` | `openssl rand -hex 32` | |
| `N8N_DB_PASSWORD` | `openssl rand -hex 24` | |
| `AGENT_CORE_TOKEN` | `openssl rand -hex 32` | Compartido n8n ↔ agent-core |
| `SUPABASE_URL` | Supabase → Settings → API | |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API | Solo en `agent-core`, nunca en n8n |
| `SUPABASE_DB_URL` | Supabase → Settings → Database | Para advisory locks vía `pg` |
| `ANTHROPIC_API_KEY` | console.anthropic.com | |
| `GEMINI_API_KEY` | aistudio.google.com | |
| `OPENAI_API_KEY` | platform.openai.com | |
| `META_APP_SECRET` | Meta App → Settings → Basic | Para el HMAC |
| `META_VERIFY_TOKEN` | Inventado | Se pega igual en el dashboard de Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta → WhatsApp → API Setup | |
| `WHATSAPP_TOKEN` | Meta → System User | Usar token permanente, no el de 24h |
| `IG_PAGE_TOKEN` | Meta → Instagram | |
| `TELEGRAM_BOT_TOKEN` | @BotFather | |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32` | Se pasa en `setWebhook` |
| `GOOGLE_SA_JSON` | GCP → Service Account | JSON en base64 |
| `GOOGLE_CALENDAR_ID` | Google Calendar → Settings | Compartir el calendario con la SA |

`.env` nunca se commitea. Mantener un `.env.example` con las claves y sin valores.

---

# Apéndice B — Errores comunes

**El handshake de Meta falla.** Se está respondiendo JSON en lugar de texto plano
con el `challenge`.

**La firma HMAC nunca coincide.** Se está hasheando el JSON re-serializado en vez
del body crudo. Activar Raw Body en el nodo Webhook.

**El bot de Instagram se responde a sí mismo en bucle.** Falta filtrar
`message.is_echo`.

**`$env.X` es `undefined` en un Code node.** Falta
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`.

**Webhook 404 aunque el workflow existe.** No está publicado, o se está usando la
Test URL sin el editor abierto.

**El agente ofrece huecos de un día distinto al preguntado.** El adaptador de
Gemini está desemparejando `functionCall`/`functionResponse` por el problema de
IDs (Fase 5.4).

**El `ALTER TABLE` de la constraint de exclusión falla.** Hay solapamientos
preexistentes; ejecutar el query de la Fase 4.0.

**El agente inventa fechas.** Falta `humanNow()` en el system prompt.

**Respuestas duplicadas al usuario.** El webhook no responde 200 antes de
procesar, y Meta reintenta.

**El agente pierde el hilo con mensajes rápidos.** Falta el advisory lock, o el
índice `conversations_one_active_idx`.

**Coste de LLM inesperadamente alto.** Falta el límite de concurrencia en n8n, el
rate limit por identidad, o el prompt caching.
