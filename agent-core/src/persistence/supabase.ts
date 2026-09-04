import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { CanonicalMessage } from "../llm/port.js";

/**
 * Lazy-initialized Supabase client
 */
let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
    if (supabaseClient) {
        return supabaseClient;
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    }

    supabaseClient = createClient(supabaseUrl, supabaseKey);
    return supabaseClient;
}

/**
 * Load conversation history from Supabase
 */
export async function loadConversationHistory( conversationId: string ): Promise<CanonicalMessage[]> {
    /**Supabase query */
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
        .from('conversations')
        .select('message_history')
        .eq('external_conversation_id', conversationId)
        .single();

    if (error || !data) {
        return [];
    }

    /**Parse and validate JSON */
    try {
        const history = data.message_history as CanonicalMessage[];
        return Array.isArray(history) ? history : [];
    } catch (error) {
        console.error('[persistence] Failed to parse message_history:', error);
        return [];
    }
}

/**
 * Save full conversation history to Supabase
 */
export async function saveConversationHistory( conversationId: string, messages: CanonicalMessage[] ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase 
        .from('conversations')
        .upsert(
            {
                external_conversation_id: conversationId,
                message_history: messages,
                last_message_at: new Date().toISOString(),
            },
            {
                onConflict: 'external_conversation_id'
            }
        );

    if (error) {
        console.error('[persistence] Failed to save conversation:', error);
        throw new Error(`Failed to save conversation: ${error.message}`);
    }
}

/**
 * Append a single message to conversations history
 */
export async function appendMessage( conversationId: string, message: CanonicalMessage): Promise<void> {
    //Verify if conversation exists
    const supabase = getSupabaseClient();
    const { data: existing } = await supabase
        .from('conversations')
        .select('id')
        .eq('external_conversation_id', conversationId)
        .single();

    if (!existing) {
        await saveConversationHistory(conversationId, [message]);
        return;
    }

    const history = await loadConversationHistory(conversationId);
    history.push(message);
    await saveConversationHistory(conversationId, history);
}