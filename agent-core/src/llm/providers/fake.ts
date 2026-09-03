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

    // Check if the LAST assistant message had a tool call
    let lastAssistantHadToolCall = false;
    let lastToolCallName = '';
    for (let i = req.messages.length - 2; i >= 0; i--) {
      const msg = req.messages[i];
      if (msg && msg.role === 'assistant') {
        for (const block of msg.blocks) {
          if (block.kind === 'tool_call') {
            lastAssistantHadToolCall = true;
            lastToolCallName = block.toolName;
            break;
          }
        }
        break; // Only check the last assistant message
      }
    }

    // If the last assistant message was a tool call, the current user message should be a tool result
    // We need to decide what to do next based on that result
    if (lastAssistantHadToolCall) {
      if (lastToolCallName === 'checkAvailability') {
        // We just got availability results back
        // Now check if the user is ready to book (has name and phone)
        const phoneMatch = userText.match(/\+?\d{10,}/);
        const nameMatch = userText.match(/(?:nombre es|me llamo|soy|nombre)\s+([a-záéíóúñ\s]+)/i);
        
        if ((phoneMatch || nameMatch) && (userText.includes('reservar') || userText.includes('14:00'))) {
          // User wants to book! Extract slot_token from the tool result
          let slotToken = 'fake-token-abc123';
          if (lastMessage) {
            for (const block of lastMessage.blocks) {
              if (block.kind === 'tool_result' && typeof block.output === 'string') {
                const tokenMatch = block.output.match(/"token":\s*"([^"]+)"/);
                if (tokenMatch && tokenMatch[1]) {
                  slotToken = tokenMatch[1];
                  break;
                }
              }
            }
          }

          return this.createToolCallResponse(
            'bookAppointment',
            {
              slot_token: slotToken,
              client_name: nameMatch?.[1]?.trim() ?? 'Juan Pérez',
              client_phone: phoneMatch?.[0] ?? '+34612345678',
            },
            'call_fake_book_001'
          );
        }

        // User is not ready to book yet, just acknowledge the availability
        return {
          message: [
            {
              role: 'assistant',
              blocks: [
                {
                  kind: 'text',
                  text: '¡Perfecto! He encontrado disponibilidad. Para confirmar la reserva, por favor indícame la hora que prefieres, tu nombre completo y tu teléfono.',
                },
              ],
            },
          ],
          stopReason: 'end_turn',
          usage: { inputTokens: 50, outputTokens: 30 },
        };
      }

      if (lastToolCallName === 'bookAppointment') {
        // We just completed a booking
        return {
          message: [
            {
              role: 'assistant',
              blocks: [
                {
                  kind: 'text',
                  text: '✅ ¡Listo! Tu cita ha sido confirmada. Te enviaremos un recordatorio antes de la fecha.',
                },
              ],
            },
          ],
          stopReason: 'end_turn',
          usage: { inputTokens: 50, outputTokens: 25 },
        };
      }
    }

    // Calculate tomorrow's date dynamically
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD

    // Simple keyword-based logic for initial requests
    if (userText.includes('disponibilidad') || userText.includes('horario') || userText.includes('mañana')) {
      // Simulate tool call for checkAvailability
      return this.createToolCallResponse(
        'checkAvailability',
        {
          date: tomorrowStr,
          service_slug: 'corte-cabello',
        },
        'call_fake_check_001'
      );
    }

    // Extract basic info for direct booking (without availability check first)
    if (userText.includes('reservar') || userText.includes('confirmar') || userText.includes('agendar')) {
      const phoneMatch = userText.match(/\+?\d{10,}/);
      const nameMatch = userText.match(/(?:nombre es|me llamo|soy|nombre)\s+([a-záéíóúñ\s]+)/i);

      if (phoneMatch || nameMatch) {
        // Direct booking without prior availability check
        return this.createToolCallResponse(
          'bookAppointment',
          {
            slot_token: 'fake-token-direct',
            client_name: nameMatch?.[1]?.trim() ?? 'Juan Pérez',
            client_phone: phoneMatch?.[0] ?? '+34600000000',
          },
          'call_fake_book_001'
        );
      }
    }

    // Default text response
    return {
      message: [
        {
          role: 'assistant',
          blocks: [
            {
              kind: 'text',
              text: '¡Hola! Soy un asistente de citas. ¿En qué puedo ayudarte? Puedo mostrarte la disponibilidad o agendar una cita.',
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
