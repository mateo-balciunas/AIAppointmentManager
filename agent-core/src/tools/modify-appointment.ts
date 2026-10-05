import { z } from 'zod';
import type { Tool, ToolExecutionResult } from './port.js';
import { getSupabaseClient, zodSchemaToJsonSchema, formatSupabaseError } from './helpers.js';
import { createCalendarEvent, deleteCalendarEvent } from '../google-calendar/sync.js';

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

      if (result.success && result.old_appointment_id && result.new_appointment_id) {
        // Get google_event_id from old appointment
        const { data: oldAppointment } = await supabase
          .from('appointments')
          .select('google_event_id')
          .eq('id', result.old_appointment_id)
          .single();

        // Delete old event from Google Calendar if exists
        if (oldAppointment?.google_event_id) {
          await deleteCalendarEvent(oldAppointment.google_event_id);
          console.log(`[modifyAppointment] Deleted old event from Calendar: ${oldAppointment.google_event_id}`);
        }

        // Get new appointment details for calendar event
        const { data: newAppointment } = await supabase
          .from('appointments')
          .select(`
            start_time,
            end_time,
            clients!inner(full_name, phone),
            services!inner(name),
            professionals!inner(full_name)
          `)
          .eq('id', result.new_appointment_id)
          .single();

        if (newAppointment) {
          // Create new event in Google Calendar
          const client = Array.isArray(newAppointment.clients) ? newAppointment.clients[0] : newAppointment.clients;
          const service = Array.isArray(newAppointment.services) ? newAppointment.services[0] : newAppointment.services;
          const professional = Array.isArray(newAppointment.professionals) ? newAppointment.professionals[0] : newAppointment.professionals;

          if (!client || !service || !professional) {
            console.error('[modifyAppointment] Missing appointment details for calendar sync');
            return {
              success: true,
              result: result,
            };
          }

          const calendarResult = await createCalendarEvent({
            summary: `${service.name} - ${client.full_name}`,
            description: `Cliente: ${client.full_name}\nTeléfono: ${client.phone}\nServicio: ${service.name}\nProfesional: ${professional.full_name}`,
            startTime: newAppointment.start_time,
            endTime: newAppointment.end_time,
          });

          if (calendarResult.success && calendarResult.eventId) {
            // Update the appointment with google_event_id
            await supabase
              .from('appointments')
              .update({
                google_event_id: calendarResult.eventId,
                google_sync_status: 'synced',
                google_synced_at: new Date().toISOString(),
              })
              .eq('id', result.new_appointment_id);
            
            console.log(`[modifyAppointment] Created new event in Calendar: ${calendarResult.eventId}`);
          } else {
            console.error('[modifyAppointment] Failed to create new event in Calendar:', calendarResult.error);
            // Mark as failed sync
            await supabase
              .from('appointments')
              .update({
                google_sync_status: 'failed',
                google_sync_error: calendarResult.error,
                google_sync_attempts: 1,
              })
              .eq('id', result.new_appointment_id);
          }
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
