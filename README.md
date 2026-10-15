# 🤖 AI Appointment Manager

> Omnichannel AI Agent for appointment scheduling via WhatsApp, Telegram & Instagram with Google Calendar integration

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-24.x-green?logo=node.js)](https://nodejs.org/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?logo=supabase)](https://supabase.com/)
[![n8n](https://img.shields.io/badge/n8n-Workflows-FF6D5A?logo=n8n)](https://n8n.io/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)](https://www.docker.com/)

---

## 📋 Overview

A production-ready, **LLM-powered conversational agent** that handles appointment scheduling across multiple messaging platforms. Built with a **provider-agnostic architecture** supporting OpenAI, Anthropic, and Google AI interchangeably.

### Key Features

- 🌐 **Omnichannel Support**: WhatsApp, Telegram, Instagram via n8n workflows
- 🧠 **LLM-Agnostic**: Swappable AI providers (OpenAI/Groq/Anthropic) with tool calling
- 📅 **Google Calendar Integration**: Automatic event creation/modification/deletion
- 🔒 **Atomic Operations**: Token-based slot reservation with expiration
- 💾 **Persistent Conversations**: Multi-turn dialogue with Supabase
- ⚡ **Type-Safe**: Full TypeScript with Zod validation
- 🐳 **Containerized**: Docker Compose for easy deployment

---

## 🏗️ Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│  WhatsApp   │────▶│             │────▶│              │
│  Telegram   │────▶│     n8n     │────▶│  agent-core  │
│  Instagram  │────▶│  Workflows  │────▶│  (TypeScript)│
└─────────────┘     └─────────────┘     └──────┬───────┘
                                               │
                    ┌──────────────────────────┼─────────────┐
                    ▼                          ▼             ▼
              ┌──────────┐            ┌──────────────┐  ┌─────────┐
              │ Supabase │            │  LLM Provider│  │ Google  │
              │(Postgres)│            │  (Groq/OAI)  │  │Calendar │
              └──────────┘            └──────────────┘  └─────────┘
```

### Components

- **`agent-core`**: TypeScript service handling LLM loop, tool execution, and business logic
- **`n8n`**: Channel adapter routing messages from messaging platforms
- **Supabase**: PostgreSQL database with RPC functions for atomic operations
- **Google Calendar API**: Bidirectional calendar synchronization

---

## 🛠️ Tech Stack

### Backend
- **Runtime**: Node.js 24.x
- **Language**: TypeScript 5.x (strict mode)
- **Validation**: Zod
- **Database**: PostgreSQL (via Supabase)
- **ORM**: Supabase Client

### AI/LLM
- **Function Calling**: Native LLM APIs (no LangChain/LlamaIndex)
- **Providers**: OpenAI, Groq, Anthropic (swappable)
- **Model**: Configurable (default: `openai/gpt-oss-120b` on Groq)

### Infrastructure
- **Orchestration**: n8n (self-hosted)
- **Containerization**: Docker Compose
- **Calendar**: Google Calendar API v3

---

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js 24.x
- Supabase project
- Groq/OpenAI API key
- Google Service Account (for Calendar)

### 1. Clone & Install

```bash
git clone https://github.com/yourusername/AIAppointmentManager.git
cd AIAppointmentManager/agent-core
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

Required variables:
```env
# LLM Provider
LLM_PROVIDER=openai
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_API_KEY=your_groq_api_key
OPENAI_MODEL=openai/gpt-oss-120b

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Google Calendar
GOOGLE_SA_JSON=base64_encoded_service_account_json
GOOGLE_CALENDAR_ID=your_calendar_id
```

### 3. Start Services

```bash
# Start n8n
cd n8n-local
docker-compose up -d

# Start agent-core
cd ../agent-core
npm run build
npm start
```

### 4. Import Workflows

1. Open n8n: `http://localhost:5678`
2. Import workflows from `/n8n-workflows/`
3. Activate workflows

---

## 🧪 Available Tools

The agent has access to 5 atomic operations:

| Tool | Description | Atomicity |
|------|-------------|-----------|
| `checkAvailability` | Query available time slots with expiring tokens | Read-only |
| `bookAppointment` | Consume slot token + create appointment + calendar event | Atomic |
| `listAppointments` | Retrieve user's appointments by phone number | Read-only |
| `cancelAppointment` | Cancel appointment + delete calendar event | Atomic |
| `modifyAppointment` | Atomic cancel + book with new slot token | Atomic |

### Example Conversation Flow

```
User: "I want to book a haircut tomorrow at 2pm"
Agent: [checkAvailability] → "I have slots at 2pm and 3pm available"
User: "2pm please, my name is John Doe, phone +34612345678"
Agent: [bookAppointment] → "✓ Booked! You'll receive a calendar invite"
```

---

## 📁 Project Structure

```
AIAppointmentManager/
├── agent-core/              # TypeScript LLM service
│   ├── src/
│   │   ├── llm/            # LLM providers & loop
│   │   ├── tools/          # Tool implementations
│   │   ├── persistence/    # Supabase client
│   │   ├── google-calendar/# Calendar sync
│   │   └── index.ts        # HTTP server
│   ├── package.json
│   └── tsconfig.json
├── n8n-local/              # n8n Docker setup
│   └── docker-compose.yaml
├── n8n-workflows/          # Exported workflows
│   ├── telegram-workflow.json
│   └── whatsapp-workflow.json
├── supabase/               # Database migrations (external)
└── README.md
```

---

## 🔒 Security Features

- ✅ **Token-based slot reservation** (prevents double-booking race conditions)
- ✅ **Zod validation** on all tool inputs
- ✅ **RPC functions** enforce business rules at database level
- ✅ **Prompt injection detection** (basic keyword filtering)
- ✅ **Service account authentication** for Google Calendar
- ✅ **Environment variables** for sensitive credentials

---

## 📊 Database Schema Highlights

### Key Tables

- `conversations`: Multi-turn conversation history (JSONB)
- `appointments`: Appointment records with Google Calendar sync status
- `availability_slots`: Time slot offerings with expiring tokens
- `channel_identities`: Omnichannel user identity mapping

### Race Condition Prevention

Uses PostgreSQL exclusion constraints with `btree_gist`:
```sql
EXCLUDE USING gist (
  professional_id WITH =,
  tstzrange(start_time, end_time) WITH &&
)
```

---

## 🧩 n8n Workflows

### Telegram Workflow
```
Telegram Trigger → Extract Message → HTTP Request (agent-core) → Send Response
```

### WhatsApp Workflow (Meta Business API)
```
Webhook → Verify/Process → HTTP Request (agent-core) → WhatsApp API → Respond
```

**Note**: WhatsApp requires Meta Business verification for production.

---

## 🌐 Deployment

### Local Development
```bash
# Terminal 1: n8n
cd n8n-local && docker-compose up

# Terminal 2: agent-core
cd agent-core && npm start

# Terminal 3: Tunnel (for webhooks)
ngrok http 5678
```

### Production Recommendations

- **Agent-core**: Deploy on Railway/Render/Fly.io
- **n8n**: Self-host on VPS with Caddy reverse proxy
- **Supabase**: Use managed Supabase or self-hosted
- **Webhooks**: Static domain or Cloudflare Tunnel

---

## 🧪 Testing

### With FakeProvider (no API calls)
```env
LLM_PROVIDER=fake
```

### With Real LLM
```env
LLM_PROVIDER=openai
OPENAI_API_KEY=your_key
```

Send test message via Telegram/Postman:
```bash
curl -X POST http://localhost:8080/v1/agent/turn \
  -H "Content-Type: application/json" \
  -d '{
    "conversation_id": "test-001",
    "message": "I want to book an appointment for tomorrow at 2pm"
  }'
```

---

## 📝 API Reference

### `POST /v1/agent/turn`

Execute one turn of the agent loop.

**Request:**
```json
{
  "conversation_id": "telegram_12345",
  "message": "I want to book a haircut"
}
```

**Response:**
```json
{
  "conversation_id": "telegram_12345",
  "message": "I can help you with that! What date works for you?",
  "iterations": 2,
  "max_iterations_reached": false
}
```

---

## 🛣️ Roadmap

- [ ] Instagram DM integration testing
- [ ] WhatsApp Business verification & production deployment
- [ ] Automated appointment reminders (24h before)
- [ ] Multi-language support (i18n)
- [ ] Analytics dashboard
- [ ] Retry logic for failed calendar syncs
- [ ] Unit & integration tests
- [ ] CI/CD pipeline

---

## 📚 Documentation

- **[GUIA.md](./GUIA.md)**: Detailed technical implementation guide (Spanish)
- **[n8n-workflows/](./n8n-workflows/)**: Workflow JSON exports with inline comments

---

## 🤝 Contributing

This is a portfolio project, but feedback and suggestions are welcome!

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

MIT License - feel free to use this project as a reference for your own work.

---

## 👤 Author

**Mateo Balciunas**

- GitHub: [https://github.com/mateo-balciunas]
- LinkedIn: [www.linkedin.com/in/mateo-balciunas-ronzoni-026658187]

---

## 🙏 Acknowledgments

- Built as a modernization of a rules-based appointment system
- Inspired by real-world business needs for omnichannel customer service
- Demonstrates production-ready patterns for LLM-powered applications

---

**⭐ If you found this project interesting, consider starring it on GitHub!**
