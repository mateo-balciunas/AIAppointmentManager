import type {
  LlmProvider,
  CanonicalMessage,
  ContentBlock,
  CompletionRequest,
  CompletionResponse,
  ToolSpec,
} from '../port.js';

/**
 * OpenAI API types (subset we need)
 */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string; // JSON string
    };
  }>;
  tool_call_id?: string; // For tool result messages
  name?: string; // Tool name for tool result messages
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

interface OpenAICompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  temperature?: number;
  max_tokens?: number;
}

interface OpenAICompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI-compatible provider (works with OpenAI and Groq)
 */
export class OpenAIProvider implements LlmProvider {
  readonly id = 'openai' as const;
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config?: { apiKey?: string; baseUrl?: string; model?: string }) {
    this.apiKey = config?.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = config?.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.model = config?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';

    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is required for OpenAIProvider');
    }
  }

  async complete(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResponse> {
    // Convert canonical messages to OpenAI format
    const openaiMessages = this.toOpenAIMessages(req.messages, req.system);

    // Convert canonical tools to OpenAI format
    const openaiTools = req.tools.map((tool) => this.toOpenAITool(tool));

    // Build OpenAI request
    const openaiRequest: OpenAICompletionRequest = {
      model: this.model,
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxOutputTokens,
    };

    // Call OpenAI API
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(openaiRequest),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const openaiResponse: OpenAICompletionResponse = await response.json();

    // Convert OpenAI response back to canonical format
    return this.toCanonicalResponse(openaiResponse);
  }

  private toOpenAIMessages(
    messages: CanonicalMessage[],
    systemPrompt: string
  ): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    // Add system prompt as first message
    result.push({
      role: 'system',
      content: systemPrompt,
    });

    // Convert canonical messages to OpenAI format
    for (const msg of messages) {
      if (msg.role === 'user') {
        // User message: extract text and tool results
        const textBlocks = msg.blocks.filter((b): b is Extract<ContentBlock, { kind: 'text' }> => b.kind === 'text');
        const toolResultBlocks = msg.blocks.filter((b): b is Extract<ContentBlock, { kind: 'tool_result' }> => b.kind === 'tool_result');

        // If has text, add as user message
        if (textBlocks.length > 0) {
          result.push({
            role: 'user',
            content: textBlocks.map((b) => b.text).join('\n'),
          });
        }

        // If has tool results, add as tool messages
        for (const toolResult of toolResultBlocks) {
          result.push({
            role: 'tool',
            tool_call_id: toolResult.callId,
            content: toolResult.isError
              ? JSON.stringify({ error: toolResult.output })
              : JSON.stringify(toolResult.output),
          });
        }
      } else if (msg.role === 'assistant') {
        // Assistant message: extract text and tool calls
        const textBlocks = msg.blocks.filter((b): b is Extract<ContentBlock, { kind: 'text' }> => b.kind === 'text');
        const toolCallBlocks = msg.blocks.filter((b): b is Extract<ContentBlock, { kind: 'tool_call' }> => b.kind === 'tool_call');

        const openaiMsg: OpenAIMessage = {
          role: 'assistant',
          content: textBlocks.length > 0 ? textBlocks.map((b) => b.text).join('\n') : null,
        };

        if (toolCallBlocks.length > 0) {
          openaiMsg.tool_calls = toolCallBlocks.map((tc) => ({
            id: tc.callId,
            type: 'function' as const,
            function: {
              name: tc.toolName,
              arguments: JSON.stringify(tc.input),
            },
          }));
        }

        result.push(openaiMsg);
      }
    }

    return result;
  }

  private toOpenAITool(tool: ToolSpec): OpenAITool {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  }

  private toCanonicalResponse(openaiResponse: OpenAICompletionResponse): CompletionResponse {
    const choice = openaiResponse.choices[0];
    if (!choice) {
      throw new Error('OpenAI returned no choices');
    }

    const blocks: ContentBlock[] = [];

    // Add text content if present
    if (choice.message.content) {
      blocks.push({
        kind: 'text',
        text: choice.message.content,
      });
    }

    // Add tool calls if present
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        blocks.push({
          kind: 'tool_call',
          callId: tc.id,
          toolName: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
    }

    // Determine stop reason
    let stopReason: CompletionResponse['stopReason'] = 'end_turn';
    if (choice.finish_reason === 'tool_calls') {
      stopReason = 'tool_call';
    } else if (choice.finish_reason === 'length') {
      stopReason = 'max_tokens';
    } else if (choice.finish_reason === 'content_filter') {
      stopReason = 'content_filtered';
    }

    return {
      message: [
        {
          role: 'assistant',
          blocks,
        },
      ],
      stopReason,
      usage: {
        inputTokens: openaiResponse.usage.prompt_tokens,
        outputTokens: openaiResponse.usage.completion_tokens,
      },
    };
  }
}
