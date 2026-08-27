import type {
    LlmProvider,
    CompletionRequest,
    CompletionResponse,
    ContentBlock,
} from '../port.js';

/**
 * FakeProvider: simulated LLM provider for testing
 * Returns predictable responses based on simple keywords
 */
export class FakeProvider implements LlmProvider {
    readonly name = 'fake';

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
        const lastMessage = request.messages[request.messages.length - 1];

        //Extract text from last user message
        let userText = '';
        if (lastMessage?.role === 'user') {
            for (const block of lastMessage.content) {
                if (block.type === 'text') {
                    userText += block.text + ' ';
                }
            }
        }

        userText = userText.toLowerCase().trim();

        //Simple logic based on keywords
        if (userText.includes('disponibilidad') || userText.includes('horario')) {
            //Simulate tool call for checkAvailability
            return this.createToolCallResponse(
                'checkAvailability',
                {
                    date: '2026-08-25',
                    service_slug: 'corte-cabello',
                },
                'call_fake_check_001'
            );
        }

        if (userText.includes('agender') || userText.includes('reservar') || userText.includes('confirmar')) {
            //Simulate tool call for bookAppointment
            return this.crateToolCallResponse(
                'bookAppointment',
                {
                    slot_token: 'fake-token-abc123',
                    client_name: 'Juan Perez',
                    client_phone: '+34600000000',
                },
                'call_fake_book_001'
            );
        }

        //Default text response 
        return {
            role: 'assistant',
            content: [
                {
                    type: 'text',
                    text: '¡Hola! Soy un asistente simulado para pruebas. ¿En qué puedo ayudarte hoy? (Intenta decir "disponibilidad" 0 "agendar").)',
                },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 20 },
        };
    }

    /**
     * Helper method to create tool call responses
     */
    private createToolCallResponse(
        toolName: string,
        toolInput: Record<string, unknown>,
        toolCallId: string
    ): CompletionResponse {
        const content: ContentBlock[] = [
            {
                type: 'tool_call',
                id: toolCallId,
                name: toolName,
                input: toolInput,
            },
        ];

        return {
            role: 'assistant',
            content,
            stop_reason: 'tool_use',
            usage: { inpit_tokens: 10, outuput_tokens: 15},
        };
    }
}
