import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import { zodToJsonSchema as zodToJsonSchemaLib } from 'zod-to-json-schema';

/**
 * Singleton supabase client, shared across all tools
 * Uses service_role credentials (RLS bypass)
 */
let supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
    if (!supabaseClient) {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            throw new Error(
                'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY are required in the env vars'
            );
        }
        supabaseClient = createClient(supabaseUrl, supabaseKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        });
    }

    return supabaseClient;
}

/**
 * Converts a Zod schema into a JSON Schema compatible with the LLM
 * 
 * @param schema - Zod schema from input arguments
 * @returns JSON Schema compatible with OpenAI/Anthropic/etc.
 */
export function zodSchemaToJsonSchema(schema: z.ZodType): Record<string, unknown> {
    const jsonSchema = zodToJsonSchemaLib(schema);

    // Only extracts the schema from the object, removing the metadata
    if (typeof jsonSchema === 'object' && jsonSchema !== null && 'definitions' in jsonSchema) {
        delete jsonSchema.definitions;
    }

    return jsonSchema as Record<string, unknown>;
}

/**
 * Formats supaase errors to return to the LLM
 * Extracts legible message and hides technical details
 * 
 * @param error - Supabase error
 * @returns Error message suitable for the LLM
 */
export function formatSupabaseError(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error) {
        const message = (error as { message: string }).message;

        //If error has known constraint code, provide more context
        if (message.includes('SLOT_CONFLICT')) {
            return 'The selected slot is already booked. Please, try a different slot.';
        }
        if (message.includes('INVALID_TOKEN')) {
            return 'Token slot is invalid or expired. Please, try again.';
        }
        if (message.includes('NO_PROFESSIONAL')) {
            return 'No available professionals at the selected date. Please, try a different date.';
        }

        // Default error message
        return message;
    }
    return 'Unknown error occurred. Please, try again later.';
}

/**
 * Generic type for responses from Supabase RPCs
 */
export type SupabaseRpcResponse<T> = {
    data: T | null;
    error: { message: string; details?: string; hint?: string; code?: string } | null;
};