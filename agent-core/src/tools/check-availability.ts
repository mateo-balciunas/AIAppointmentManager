import { z } from 'zod';
import type { Tool, ToolExecutionResult } from './port.js';
import { getSupabaseClient, zodSchemaToJsonSchema, formatSupabaseError } from './helpers.js';

/**
 * Zod schema for input arguments for the checkAvailability tool
 */
const checkAvailabilityInputSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .describe('Date to check availability formatted as YYYY-MM-DD (e.g: 2026-08-25)'),
  service_slug: z
    .string()
    .min(1, 'The service slug is required')
    .describe('Service identifier (e.g: "corte-cabello", "manicura")'),
});

/**
 * TypeScript interface type from zod schema
 */
type CheckAvailabilityInput = z.infer<typeof checkAvailabilityInputSchema>;

/**
 * Available slot structure. Returned by Supabase
 */
interface AvailableSlot {
  slot_token: string;
  start_time: string; // ISO 8601 timestamptz
  end_time: string;   // ISO 8601 timestamptz
  professional_name: string;
}

/**
 * Success result type
 */
interface CheckAvailabilityOutput {
  available_slots: AvailableSlot[];
  date: string;          // Asked date (for context)
  service_slug: string;  // Asked service slug (for context)
}

/**
 * Tool to check available slots
 */
export class CheckAvailabilityTool implements Tool<CheckAvailabilityInput, CheckAvailabilityOutput> {
  readonly name = 'checkAvailability';
  
  readonly description = `Check available slots for a service on a specific date.

USAGE:
- Use when the user asks for availability, schedules, or wants to know free slots.
- Always check availability BEFORE attempting to book.

IMPORTANT:
- Slot tokens are valid for 5 minutes after being generated.
- Must use token immediately with bookAppointment if the user confirms.`;

  readonly inputSchema = checkAvailabilityInputSchema;

  async execute(input: CheckAvailabilityInput): Promise<ToolExecutionResult<CheckAvailabilityOutput>> {
    try {
      const supabase = getSupabaseClient();

      // Call the RPC Supabase function
      const { data, error } = await supabase.rpc('fn_check_availability_v2', {
        p_date: input.date,
        p_service_slug: input.service_slug,
      });

      if (error) {
        return {
          success: false,
          error: formatSupabaseError(error),
        };
      }

      // If there are no slots, return empty array (not an error)
      const slots = (data || []) as AvailableSlot[];

      return {
        success: true,
        result: {
          available_slots: slots,
          date: input.date,
          service_slug: input.service_slug,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: formatSupabaseError(err),
      };
    }
  }

  toJsonSchema(): Record<string, unknown> {
    return zodSchemaToJsonSchema(this.inputSchema);
  }
}
