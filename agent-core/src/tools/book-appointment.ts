import { z } from 'zod';
import type { Tool, ToolExecutionResult } from './port.js';
import { getSupabaseClient, zodSchemaToJsonSchema, formatSupabaseError } from './helpers.js';
import { createCalendarEvent } from '../google-calendar/sync.js';

/**
 * Zod schema for input arguments for the bookAppointment tool
 */
const bookAppointmentInputSchema = z.object({
  slot_token: z
    .string()
    .min(1, 'Slot token is required')
    .describe('Token obtained from checkAvailability (valid for 5 minutes)'),
  client_name: z
    .string()
    .min(2, 'Client name must be at least 2 characters')
    .max(100, 'Client name must be at most 100 characters')
    .describe('Full name of the client booking the appointment'),
  client_phone: z
    .string()
    .regex(/^\+?[1-9]\d{1,14}$/, 'Phone must be in international format (e.g: +34600000000)')
    .describe('Client phone number in international format with country code'),
});

/**
 * TypeScript interface type from zod schema
 */
type BookAppointmentInput = z.infer<typeof bookAppointmentInputSchema>;

/**
 * Success result type
 */
interface BookAppointmentOutput {
  appointment_id: string;
  start_time: string;     // ISO 8601 timestamptz
  end_time: string;       // ISO 8601 timestamptz
  service_name: string;
  professional_name: string;
  client_name: string;
  client_phone: string;
}

/**
 * Tool to book an appointment atomically
 */
export class BookAppointmentTool implements Tool<BookAppointmentInput, BookAppointmentOutput> {
  readonly name = 'bookAppointment';
  
  readonly description = `Books an appointment using a slot token from checkAvailability.

USAGE:
- Use ONLY after the user explicitly confirms they want to book.
- The slot_token must come from a recent checkAvailability call (max 5 minutes old).
- ALWAYS ask for client name and phone if not already provided.

IMPORTANT:
- This operation is atomic and irreversible.
- If the token is expired or the slot was taken, you'll receive an error.
- In case of error, call checkAvailability again to get new slots.`;

  readonly inputSchema = bookAppointmentInputSchema;

  async execute(input: BookAppointmentInput): Promise<ToolExecutionResult<BookAppointmentOutput>> {
    try {
      const supabase = getSupabaseClient();

      // Call the RPC Supabase function for atomic booking
      const { data, error } = await supabase.rpc('fn_book_appointment_v2', {
        p_slot_token: input.slot_token,
        p_client_name: input.client_name,
        p_client_phone: input.client_phone,
      });

      if (error) {
        return {
          success: false,
          error: formatSupabaseError(error),
        };
      }

      // data should be a single row with appointment details
      if (!data || (Array.isArray(data) && data.length === 0)) {
        return {
          success: false,
          error: 'Booking succeeded but no appointment data was returned',
        };
      }

      // Extract the first row (fn_book_appointment_v2 returns a single row)
      const appointment = Array.isArray(data) ? data[0] : data;

      // Prepare the result
      const bookingResult: BookAppointmentOutput = {
        appointment_id: appointment.appointment_id,
        start_time: appointment.start_time,
        end_time: appointment.end_time,
        service_name: appointment.service_name,
        professional_name: appointment.professional_name,
        client_name: appointment.client_name,
        client_phone: appointment.client_phone,
      };

      // Try to sync with Google Calendar
      const calendarResult = await createCalendarEvent({
        summary: `${bookingResult.service_name} - ${bookingResult.client_name}`,
        description: `Cliente: ${bookingResult.client_name}\nTeléfono: ${bookingResult.client_phone}\nServicio: ${bookingResult.service_name}\nProfesional: ${bookingResult.professional_name}`,
        startTime: bookingResult.start_time,
        endTime: bookingResult.end_time,
      });

      if (calendarResult.success && calendarResult.eventId) {
        // Update the appointment in Supabase with the google_event_id
        await supabase
          .from('appointments')
          .update({
            google_event_id: calendarResult.eventId,
            google_sync_status: 'synced',
            google_synced_at: new Date().toISOString(),
          })
          .eq('id', bookingResult.appointment_id);
        
        console.log(`[bookAppointment] Successfully synced to Google Calendar: ${calendarResult.eventId}`);
      } else {
        // Failed attempt but booking is still successful
        console.error('[bookAppointment] Google Calendar sync failed:', calendarResult.error);
        await supabase
          .from('appointments')
          .update({
            google_sync_status: 'failed',
            google_sync_error: calendarResult.error,
            google_sync_attempts: 1,
          })
          .eq('id', bookingResult.appointment_id);
      }

      // Return success regardless of Google Calendar sync status
      return {
        success: true,
        result: bookingResult,
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
