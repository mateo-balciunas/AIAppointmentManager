import { z } from 'zod';
import type { Tool, ToolExecutionResult } from './port.js';
import { getSupabaseClient, zodSchemaToJsonSchema, formatSupabaseError } from './helpers.js';

/**
 * Zod schema for input arguments
 */
const listAppointmentsInputSchema = z.object({
  client_phone: z
    .string()
    .regex(/^\+\d{10,15}$/, 'Formato E.164: +34612345678'),
  status: z
    .enum(['confirmed', 'cancelled', 'all'])
    .describe('Estado de las citas a buscar (por defecto: confirmed)'),
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD')
    .optional()
    .describe('Fecha desde la cual buscar (por defecto: hoy)'),
});

type ListAppointmentsInput = z.infer<typeof listAppointmentsInputSchema>;

/**
 * Individual appointment info
 */
interface AppointmentInfo {
  appointment_id: string;
  service_name: string;
  professional_name: string;
  start_time: string;
  end_time: string;
  status: string;
  notes: string | null;
}

/**
 * Success result type
 */
interface ListAppointmentsOutput {
  count: number;
  appointments: AppointmentInfo[];
}

/**
 * Tool: listAppointments
 * Lists all appointments for a client by phone number
 */
export class ListAppointmentsTool implements Tool<ListAppointmentsInput, ListAppointmentsOutput> {
  readonly name = 'listAppointments';

  readonly description = `List all appointments for a client by phone number.
Use this when the user wants to see their scheduled appointments, check their calendar, or before modifying/cancelling a specific appointment.
Returns a list of appointments with IDs, dates, services, and professionals.`;

  readonly inputSchema = listAppointmentsInputSchema;

  async execute(input: ListAppointmentsInput): Promise<ToolExecutionResult<ListAppointmentsOutput>> {
    try {
      const supabase = getSupabaseClient();

      const { data, error } = await supabase.rpc('fn_list_appointments', {
        p_client_phone: input.client_phone,
        p_status: input.status || 'confirmed',
        p_from_date: input.from_date || new Date().toISOString().split('T')[0],
      });

      if (error) {
        return {
          success: false,
          error: formatSupabaseError(error),
        };
      }

      const appointments = (data || []) as AppointmentInfo[];

      return {
        success: true,
        result: {
          count: appointments.length,
          appointments: appointments,
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
