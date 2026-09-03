import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Load .env from project root (one level up from agent-core/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '../../.env') });

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { runAgentTurn } from './llm/loop.js';
import type { CanonicalMessage } from './llm/port.js';

const PORT = parseInt(process.env.PORT ?? '8080', 10);

/**
 * In-memory conversations storage (temporary, TODO replace with supabase)
 * Key: conversation_id, Value: message history
 */
const conversationStore = new Map<string, CanonicalMessage[]>();

/**
 * Parse JSON body from request
 */
async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Handle /v1/agent/turn endpoint
 */
async function handleAgentTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Parse request body
    const body = await parseJsonBody(req);

    // Validate request
    if (!body || typeof body !== 'object') {
      sendJson(res, 400, { error: 'Request body must be a JSON object' });
      return;
    }

    const { conversation_id, message } = body as { conversation_id?: unknown; message?: unknown };

    if (!conversation_id || typeof conversation_id !== 'string') {
      sendJson(res, 400, { error: 'conversation_id is required and must be a string' });
      return;
    }

    if (typeof message !== 'string' || !message.trim()) {
      sendJson(res, 400, { error: 'message is required and must be a non-empty string' });
      return;
    }

    // Rate limiting: max 1000 characters per message
    if (message.length > 1000) {
      sendJson(res, 400, { error: 'message is too long. Max 1000 characters allowed' });
      return;
    }

    // Get conversation history (in-memory)
    const conversationHistory = conversationStore.get(conversation_id) || [];

    // Run agent turn
    const result = await runAgentTurn(message, conversationHistory);

    // Update conversation history in memory
    conversationStore.set(conversation_id, result.messageHistory);

    // Return response
    sendJson(res, 200, {
      conversation_id,
      message: result.finalMessage,
      iterations: result.iterations,
      max_iterations_reached: result.maxIterationsReached,
    });
  } catch (error) {
    console.error('[agent-core] Error in /v1/agent/turn:', error);
    sendJson(res, 500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

const server = createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    sendJson(res, 200, {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      provider: process.env.LLM_PROVIDER || 'fake',
    });
    return;
  }

  if (req.url === '/v1/agent/turn' && req.method === 'POST') {
    handleAgentTurn(req, res).catch((error) => {
      console.error('[agent-core] Unhandled error:', error);
      sendJson(res, 500, { error: 'Internal server error' });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[agent-core] Server listening on port ${PORT}`);
  console.log(`[agent-core] Health check: http://localhost:${PORT}/health`);
  console.log(`[agent-core] Agent endpoint: POST http://localhost:${PORT}/v1/agent/turn`);
  console.log(`[agent-core] LLM Provider: ${process.env.LLM_PROVIDER || 'fake'}`);
});
