import { z } from 'zod';
import type { Tool, ToolExecutionResult } from './port.js';
import { getSupabaseClient, zodSchemaToJsonSchema, formatSupabaseError } from './helpers.js';
import { deleteCalendarEvent } from '../google-calendar/sync.js'; 

/**
 * Zod schema for input arguments
 */
const cancelAppointmentInputSchema = z.object({
  appointment_id: z.string().uuid('ID de cita inválido'),
  client_phone: z
    .string()
    .regex(/^\+\d{10,15}$/, 'Formato E.164: +34612345678'),
  cancellation_reason: z
    .string()
    .optional()
    .describe('Razón de la cancelación (opcional)'),
});

type CancelAppointmentInput = z.infer<typeof cancelAppointmentInputSchema>;

/**
 * Success result type
 */
interface CancelAppointmentOutput {
  success: boolean;
  appointment_id: string;
  message: string;
  error?: string;
}

/**
 * Tool: cancelAppointment
 * Cancels an existing appointment
 */
export class CancelAppointmentTool implements Tool<CancelAppointmentInput, CancelAppointmentOutput> {
  readonly name = 'cancelAppointment';

  readonly description = `Cancel an existing appointment.
IMPORTANT: Before cancelling, you MUST call listAppointments to show the user their appointments and get the appointment_id.
Never guess or invent appointment IDs.
Always confirm with the user which appointment they want to cancel.`;

  readonly inputSchema = cancelAppointmentInputSchema;

  async execute(input: CancelAppointmentInput): Promise<ToolExecutionResult<CancelAppointmentOutput>> {
    try {
      const supabase = getSupabaseClient();

      const { data, error } = await supabase.rpc('fn_cancel_appointment', {
        p_appointment_id: input.appointment_id,
        p_client_phone: input.client_phone,
        p_cancellation_reason: input.cancellation_reason || null,
      });

      if (error) {
        return {
          success: false,
          error: formatSupabaseError(error),
        };
      }

      const result = data as CancelAppointmentOutput;
      
      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Unknown error from database',
        };
      }

      // Si la cancelación fue exitosa, eliminar de Google Calendar
      const { data: appointment } = await supabase
        .from('appointments')
        .select('google_event_id')
        .eq('id', input.appointment_id)
        .single();

      if (appointment?.google_event_id) {
        const calendarResult = await deleteCalendarEvent(appointment.google_event_id);

        if (!calendarResult.success) {
          console.error('[cancelAppointment] Failed to delete from Google Calendar:', calendarResult.error);
        } else {
          console.log(`[cancelAppointment] Successfully deleted from Google Calendar: ${appointment.google_event_id}`);
        }
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
