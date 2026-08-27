import type { z } from 'zod';

/**
 * Result of a tool call execution
 *  - success: true -> result contains the value type T
 *  - success: false -> error contains the error message
 */
export type ToolExecutionResult<T> = 
    | { success: true, result: T }
    | { success: false, error: string };

/**
 * Generic contract for any tool implementation
 * @template TInput - Input arguments type (inferred from Zod schema)
 * @template TOuptut - Result type 
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
    /**Unique tool name (ej: "checkAvailability") */
    readonly name: string;

    /**Description for the LLM (explains when and how to use the tool) */
    readonly description: string;

    /**Zod schema, defines and validates the input arguments */
    readonly inputSchema: z.ZodType<TInput>;

    /**
     * Executes the tool with validated arguments
     * 
     * @param input - Validated arguments by inputSchema
     * @returns Success or error results
     */
    execute(input: TInput): Promise<ToolExecutionResult<TOuput>>;

    /**
     * Transforms the Zod schema into a JSON Schema to send to the LLM
     */
    toJsonSchema(): Record<string, unknown>;
}

/**
 * Specifies the tool sent to the LLM
 * Contains all the info that the LLM needs to decide to call the tool
 */
export interface ToolSpec {
    /** Name of the tool */
    name: string;

    /** Detailed description of the tool  */
    description: string;

    /** JSON Schema of the input parameters */
    input_schema: Record<string, unknown>;
}