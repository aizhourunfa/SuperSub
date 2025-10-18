import type { Env } from './types';

export async function sendTelegramMessage(env: Env, userId: string, message: string) {
    const { results } = await env.DB.prepare(
        `SELECT key, value FROM settings WHERE user_id = ? AND key IN ('telegram_bot_token', 'telegram_chat_id')`
    ).bind(userId).all<{ key: string, value: string }>();

    const settings = (results as any[]).reduce((acc, setting) => {
        acc[setting.key] = setting.value;
        return acc;
    }, {} as Record<string, string>);

    const botToken = settings['telegram_bot_token'];
    const chatId = settings['telegram_chat_id'];

    if (!botToken || !chatId) {
        // Telegram bot token or chat ID is not configured, do nothing.
        return;
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'HTML',
            }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Failed to send Telegram message:', errorData);
        }
    } catch (error) {
        console.error('Error sending Telegram message:', error);
    }
}