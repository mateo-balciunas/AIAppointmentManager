import { z } from 'zod';
import type { Tool, ToolExecutionResult } from './port.js';
import { getSupabaseClient, zodSchemaToJsonSchema, formatSupabaseError } from './helpers.js';

/**
 * Zod schema for input arguments
 */
const modifyAppointmentInputSchema = z.object({
  appointment_id: z.string().uuid('ID de la cita inválido'),
  client_phone: z
    .string()
    .regex(/^\+\d{10,15}$/, 'Formato E.164: +34612345678'),
  new_slot_token: z
    .string()
    .min(1, 'Token de disponibilidad requerido')
    .describe('Token del nuevo horario deseado (de checkAvailability)'),
});

type ModifyAppointmentInput = z.infer<typeof modifyAppointmentInputSchema>;

/**
 * Success result type
 */
interface ModifyAppointmentOutput {
  success: boolean;
  old_appointment_id: string;
  new_appointment_id: string;
  new_start_time: string;
  new_end_time: string;
  message: string;
  error?: string;
}

/**
 * Tool: modifyAppointment
 * Modifies an existing appointment to a new date/time
 */
export class ModifyAppointmentTool implements Tool<ModifyAppointmentInput, ModifyAppointmentOutput> {
  readonly name = 'modifyAppointment';

  readonly description = `Modify an existing appointment to a new date/time.
IMPORTANT workflow:
1. First call listAppointments to show the user their current appointments
2. User selects which appointment to modify
3. Call checkAvailability for the new desired date/service
4. User confirms new time slot
5. Call modifyAppointment with appointment_id and new_slot_token

This will cancel the old appointment and create a new one automatically.
Never guess or invent appointment IDs - always use listAppointments first.`;

  readonly inputSchema = modifyAppointmentInputSchema;

  async execute(input: ModifyAppointmentInput): Promise<ToolExecutionResult<ModifyAppointmentOutput>> {
    try {
      const supabase = getSupabaseClient();

      const { data, error } = await supabase.rpc('fn_modify_appointment', {
        p_appointment_id: input.appointment_id,
        p_client_phone: input.client_phone,
        p_new_slot_token: input.new_slot_token,
      });

      if (error) {
        return {
          success: false,
          error: formatSupabaseError(error),
        };
      }

      const result = data as ModifyAppointmentOutput;

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Unknown error from database',
        };
      }

      return {
        success: true,
        result: result,
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
