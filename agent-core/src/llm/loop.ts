import type { CanonicalMessage, ContentBlock } from './port.js';
import { getConfiguredProvider } from './registry.js';
import { toolRegistry } from '../tools/registry.js';

/**
 * Configuration for the agent loop
 */
interface AgentLoopConfig {
  /** Maximum number of LLM calls in a single turn (prevents infinite loops) */
  maxIterations?: number;
  /** System prompt for the agent */
  systemPrompt?: string;
  /** Business timezone for date/time interpretation */
  businessTimezone?: string;
}

/**
 * Result of running an agent turn
 */
export interface AgentTurnResult {
  /** Final response message to send to the user */
  finalMessage: string;
  /** Number of LLM calls made during this turn */
  iterations: number;
  /** Whether the max iterations limit was reached */
  maxIterationsReached: boolean;
  /** Full message history (for persistence/debugging) */
  messageHistory: CanonicalMessage[];
}

/**
 * Default system prompt for the appointment scheduling agent
 */
const DEFAULT_SYSTEM_PROMPT = `You are a helpful appointment scheduling assistant for a services business.

Your capabilities:
- Check available time slots for services
- Book appointments when the user confirms
- Answer questions about services and availability

Guidelines:
1. ALWAYS be polite, professional, and clear.
2. ALWAYS check availability before booking.
3. ALWAYS confirm all details with the user before calling bookAppointment.
4. Ask for missing information (name, phone) before booking.
5. If a booking fails due to conflict, immediately check availability again.
6. Use the business timezone ({{TIMEZONE}}) when interpreting dates and times.

When the user asks about availability, call checkAvailability.
When the user confirms they want to book, call bookAppointment with the slot_token from the previous availability check.

Current date: {{CURRENT_DATE}}
Business timezone: {{TIMEZONE}}`;

/**
 * Prompt injection detection function
 */
function detectPromptInjection(userMessage: string): boolean {
  const suspiciousPatterns = [
    /ignore (previous|all) instructions?/i,
    /you are now/i,
    /new (role|system prompt|instructions)/i,
    /act as a|pretend to be/i,
    /forget (everything|all|your)/i,
  ];

  return suspiciousPatterns.some((pattern) => pattern.test(userMessage));
}

/**
 * Output sanitization, prevents dangerous hallucinations
 */
function sanitizeFinalMessage(message: string): string {
  // Remove suspicious URLs
  const sanitized = message.replace(
    /https?:\/\/[^\s]+/g,
    '[URL removed for security]'
  );

  return sanitized;
}

/**
 * Run a single agent turn (user message -> agent response)
 *
 * @param userMessage - The user's message text
 * @param conversationHistory - Previous messages in the conversation (optional)
 * @param config - Configuration options
 * @returns The agent's response and updated message history
 */
export async function runAgentTurn(
  userMessage: string,
  conversationHistory: CanonicalMessage[] = [],
  config: AgentLoopConfig = {}
): Promise<AgentTurnResult> {
  const {
    maxIterations = 10,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    businessTimezone = process.env.BUSINESS_TIMEZONE || 'UTC',
  } = config;

  // Initialize message history with conversation history + new user message
  const messages: CanonicalMessage[] = [
    ...conversationHistory,
    {
      role: 'user',
      content: [{ type: 'text', text: userMessage }],
    },
  ];

  // Prepare system prompt with dynamic values
  const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const finalSystemPrompt = systemPrompt
    .replace(/\{\{TIMEZONE\}\}/g, businessTimezone)
    .replace(/\{\{CURRENT_DATE\}\}/g, currentDate);

  // Get LLM provider and tool specifications
  const llm = getConfiguredProvider();
  const tools = toolRegistry.toToolSpecs();

  let iterations = 0;
  let finalMessage = '';
  let maxIterationsReached = false;

  // Check for prompt injection
  if (detectPromptInjection(userMessage)) {
    return {
      finalMessage: 'I can only help with appointment scheduling. How can I assist you today?',
      iterations: 0,
      maxIterationsReached: false,
      messageHistory: messages,
    };
  }

  // Agent loop
  while (iterations < maxIterations) {
    iterations++;

    // Call LLM
    const response = await llm.complete({
      messages,
      tools,
      system_prompt: finalSystemPrompt,
    });

    // Add assistant response to history
    messages.push({
      role: 'assistant',
      content: response.content,
    });

    // Check if the response contains tool calls
    const toolCalls = response.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool_call' }> =>
        block.type === 'tool_call'
    );

    // If no tool calls, extract text and finish
    if (toolCalls.length === 0) {
      const textBlocks = response.content.filter(
        (block): block is Extract<ContentBlock, { type: 'text' }> =>
          block.type === 'text'
      );
      finalMessage = textBlocks.map((block) => block.text).join('\n');
      break;
    }

    // Execute all tool calls
    const toolResults: ContentBlock[] = [];

    for (const toolCall of toolCalls) {
      try {
        // Get tool from registry
        const tool = toolRegistry.get(toolCall.name);

        // Validate input with Zod
        const parseResult = tool.inputSchema.safeParse(toolCall.input);

        if (!parseResult.success) {
          // Validation failed: return error to LLM
          toolResults.push({
            type: 'tool_result',
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              error: 'Invalid arguments',
              details: parseResult.error.format(),
            }),
          });
          continue;
        }

        // Execute tool
        const executionResult = await tool.execute(parseResult.data);

        if (executionResult.success) {
          // Success: return result to LLM
          toolResults.push({
            type: 'tool_result',
            tool_call_id: toolCall.id,
            content: JSON.stringify(executionResult.result),
          });
        } else {
          // Failed: return error to LLM
          toolResults.push({
            type: 'tool_result',
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              error: executionResult.error,
            }),
          });
        }
      } catch (error) {
        // Unexpected error
        toolResults.push({
          type: 'tool_result',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
        });
      }
    }

    // Add tool results to message history
    messages.push({
      role: 'user',
      content: toolResults,
    });
  }

  // Check if max iterations was reached
  if (iterations >= maxIterations) {
    maxIterationsReached = true;
    finalMessage = 'Sorry, I encountered an issue processing your request. Please try again.';
  }

  return {
    finalMessage: sanitizeFinalMessage(finalMessage),
    iterations,
    maxIterationsReached,
    messageHistory: messages,
  };
}
