import { google } from 'googleapis';

/**
 * Get authenticated Google Calendar client
 */
export function getCalendarClient() {
    const serviceAccountBase64 = process.env.GOOGLE_SA_JSON;
    const calendarId = process.env.GOOGLE_CALENDAR_ID;

    if (!serviceAccountBase64) {
        throw new Error('GOOGLE_SA_JSON is not configured in enviroment variables');
    }
    if (!calendarId) {
        throw new Error('GOOGLE_CALENDAR_ID is not configured in enviroment variables');
    }

    // Decode base 64 to json
    const serviceAccountJson = Buffer.from(serviceAccountBase64, 'base64').toString('utf-8');
    const serviceAccount = JSON.parse(serviceAccountJson);

    //Create OAuth2 client with Service Account
    const auth = new google.auth.GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    const calendar = google.calendar({ version: 'v3', auth });

    return { calendar, calendarId };
}