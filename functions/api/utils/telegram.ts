import type { Env } from './types';

export async function sendTelegramMessage(env: Env, userId: string, message: string) {
    const { results } = await env.DB.prepare(
        `SELECT key, value FROM settings WHERE user_id = ? AND key IN ('telegram_bot_token', 'telegram_chat_id', 'ipinfo_token')`
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

interface IpApiData {
    org?: string;
    as?: string;
    status: string;
}

export async function getIpInfo(ip: string) {
    // Do not query for private IP addresses
    if (!ip || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.')) {
        return { isp: 'N/A', asn: 'N/A' };
    }
    try {
        const response = await fetch(`http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,org,as`);
        if (!response.ok) {
            console.error(`Failed to fetch IP info from ip-api.com: ${response.status} ${response.statusText}`);
            return { isp: 'N/A', asn: 'N/A' };
        }
        const data = await response.json() as IpApiData;
        if (data.status !== 'success') {
            return { isp: 'N/A', asn: 'N/A' };
        }
        return {
            isp: data.org || 'N/A',
            asn: data.as || 'N/A',
        };
    } catch (error) {
        console.error('Error fetching IP info from ip-api.com:', error);
        return { isp: 'N/A', asn: 'N/A' };
    }
}
export interface NotificationData {
    ip: string;
    country: string | null;
    city: string | null;
    isp: string;
    asn: string;
    domain: string;
    client: string;
    requestType: string;
    subscriptionGroup: string;
}

export async function sendSubscriptionAccessNotification(env: Env, userId: string, data: NotificationData) {
    const message = `
🚀 订阅被访问

IP 地址: ${data.ip}
国家: ${data.country || 'N/A'}
城市: ${data.city || 'N/A'}
ISP: ${data.isp}
ASN: ${data.asn}
域名: ${data.domain}
客户端: ${data.client}
请求格式: ${data.requestType}
订阅组: ${data.subscriptionGroup}

时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} (UTC+8)
    `.trim();

    await sendTelegramMessage(env, userId, message);
}