import type {
  LlmProvider,
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
} from '../port.js';

/**
 * FakeProvider: simulated LLM provider for testing.
 * Returns predictable responses based on simple keywords.
 * Does NOT make real HTTP calls.
 */
export class FakeProvider implements LlmProvider {
  readonly id = 'fake' as const;

  async complete(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResponse> {
    const lastMessage = req.messages[req.messages.length - 1];

    // Extract text from last user message
    let userText = '';
    if (lastMessage?.role === 'user') {
      for (const block of lastMessage.blocks) {
        if (block.kind === 'text') {
          userText += block.text + ' ';
        }
      }
    }

    userText = userText.toLowerCase().trim();

    // Simple keyword-based logic
    if (userText.includes('disponibilidad') || userText.includes('horario')) {
      // Simulate tool call for checkAvailability
      return this.createToolCallResponse(
        'checkAvailability',
        {
          date: '2026-08-25',
          service_slug: 'corte-cabello',
        },
        'call_fake_check_001'
      );
    }

    if (userText.includes('agendar') || userText.includes('reservar') || userText.includes('confirmar')) {
      // Simulate tool call for bookAppointment
      return this.createToolCallResponse(
        'bookAppointment',
        {
          slot_token: 'fake-token-abc123',
          client_name: 'Juan Pérez',
          client_phone: '+34600000000',
        },
        'call_fake_book_001'
      );
    }

    // Default text response
    return {
      message: [
        {
          role: 'assistant',
          blocks: [
            {
              kind: 'text',
              text: '¡Hola! Soy un asistente simulado. ¿En qué puedo ayudarte hoy? (Intenta decir "disponibilidad" o "agendar").',
            },
          ],
        },
      ],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 20 },
    };
  }

  /**
   * Helper to create responses with tool_call
   */
  private createToolCallResponse(
    toolName: string,
    toolInput: Record<string, unknown>,
    callId: string
  ): CompletionResponse {
    const blocks: ContentBlock[] = [
      {
        kind: 'tool_call',
        callId,
        toolName,
        input: toolInput,
      },
    ];

    return {
      message: [
        {
          role: 'assistant',
          blocks,
        },
      ],
      stopReason: 'tool_call',
      usage: { inputTokens: 10, outputTokens: 15 },
    };
  }
}
