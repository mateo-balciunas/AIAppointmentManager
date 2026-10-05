import { getCalendarClient } from "./client.js";
import type { calendar_v3 } from "googleapis";

/**
 * Create a new event in Google Calendar
 */
export async function createCalendarEvent(params: {
    summary: string;
    description?: string;
    startTime: string;
    endTime: string;
    attendeeEmail?: string;
    attendeeName?: string;
}): Promise<{ success: boolean; eventId?: string; error?: string }> {
    try {
        const { calendar, calendarId } = getCalendarClient();

        const event: calendar_v3.Schema$Event = {
            summary: params.summary,
            description: params.description ?? null,
            start: {
                dateTime: params.startTime,
                timeZone: process.env.BUSINESS_TIMEZONE || 'UTC',
            },
            end: {
                dateTime: params.endTime,
                timeZone: process.env.BUSINESS_TIMEZONE || 'UTC',
            },
            reminders: {
                useDefault: false,
                overrides: [
                    { method: 'email', minutes: 24 * 60 },
                    { method: 'popup', minutes: 60 },
                ],
            },
        };

        // Add attendees only if provided
        if (params.attendeeEmail) {
            event.attendees = [
                {
                    email: params.attendeeEmail,
                    displayName: params.attendeeName ?? null,
                    responseStatus: 'needsAction',
                },
            ];
        }

        const response = await calendar.events.insert({
            calendarId: calendarId,
            requestBody: event,
            sendUpdates: 'all',
        });

        const eventId = response.data.id;
        if (!eventId) {
            return {
                success: false,
                error: 'Event created but no ID returned',
            };
        }

        return {
            success: true,
            eventId: eventId,
        };
    } catch (error) {
        console.error('[Google Calendar] Create event error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * Update a existing event in Google Calendar
 */
export async function updateCalendarEvent(params: {
    eventId: string;
    summary?: string;
    description?: string;
    startTime?: string;
    endTime?: string;
}): Promise<{ success: boolean; error?: string }> {
    try {
        const { calendar, calendarId } = getCalendarClient();

        const event: calendar_v3.Schema$Event = {};

        if (params.summary !== undefined) {
            event.summary = params.summary;
        }
        if (params.description !== undefined) {
            event.description = params.description;
        }
        if (params.startTime) {
            event.start = {
                dateTime: params.startTime,
                timeZone: process.env.BUSINESS_TIMEZONE || 'UTC',
            };
        }
        if (params.endTime) {
            event.end = {
                dateTime: params.endTime,
                timeZone: process.env.BUSINESS_TIMEZONE || 'UTC',
            };
        }

        await calendar.events.patch({
            calendarId: calendarId,
            eventId: params.eventId,
            requestBody: event,
            sendUpdates: 'all',
        });

        return { success: true };
    } catch (error) {
        console.error('[Google Calendar] Update event error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * Delete (cancel) an existing event in Google Calendar
 */
export async function deleteCalendarEvent(eventId: string): Promise<{ success: boolean; error?: string }> {
    try {
        const { calendar, calendarId } = getCalendarClient();

        await calendar.events.delete({
            calendarId: calendarId,
            eventId: eventId,
            sendUpdates: 'all',
        });

        return { success: true };
    } catch (error) {
        console.error('[Google Calendar] Delete event error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}