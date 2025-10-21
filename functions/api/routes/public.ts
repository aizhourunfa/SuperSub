import { Hono } from 'hono';
import { Buffer } from 'node:buffer';
import type { AppContext } from '../utils/types';
import { getIpInfo, sendSubscriptionAccessNotification } from '../utils/telegram';
import { generateSubscription } from '../utils/profileGenerator';
import { Logger } from '../utils/logger';

const publicRoutes = new Hono<AppContext>();

// This is the main subscription route
publicRoutes.get('/:sub_token/:profile_alias', async (c) => {
    const { sub_token, profile_alias } = c.req.param();

    // 1. Find user by sub_token
    const user = await c.env.DB.prepare('SELECT * FROM users WHERE sub_token = ?').bind(sub_token).first<any>();
    if (!user) return c.text('Invalid subscription token', 404);

    // 2. Find profile by alias and user_id
    const profile = await c.env.DB.prepare('SELECT * FROM profiles WHERE (id = ? OR alias = ?) AND user_id = ?').bind(profile_alias, profile_alias, user.id).first<any>();
    if (!profile) return c.text('Profile not found', 404);

    // --- Start of Access Logging & Notification ---
    const handleAccess = async () => {
        try {
            const ip_address = c.req.header('CF-Connecting-IP') || 'N/A';
            const user_agent = c.req.header('User-Agent') || 'N/A';
            const cf = (c.req.raw as any).cf;
            const country = cf?.country || null;
            const city = cf?.city || null;

            // Log access to DB
            await c.env.DB.prepare(
                'INSERT INTO subscription_access_logs (user_id, profile_id, ip_address, user_agent, country, city) VALUES (?, ?, ?, ?, ?, ?)'
            ).bind(user.id, profile.id, ip_address, user_agent, country, city).run();

            // Fetch additional info for notification
            const { isp, asn } = await getIpInfo(ip_address);
            const url = new URL(c.req.url);
            const domain = url.hostname;
            
            // Determine request type
            const target = url.searchParams.get('target');
            let requestType = 'other';
            if (target) {
                requestType = target;
            } else if (c.req.header('User-Agent')?.toLowerCase().includes('clash')) {
                requestType = 'clash';
            }

            // The "subscription group" is the profile name itself
            const subscriptionGroup = profile.name;

            await sendSubscriptionAccessNotification(c.env, user.id, {
                ip: ip_address,
                country,
                city,
                isp,
                asn,
                domain,
                client: user_agent,
                requestType,
                subscriptionGroup,
            });

        } catch (e) {
            console.error("Failed to log subscription access or send notification:", e);
        }
    };
    c.executionCtx.waitUntil(handleAccess());
    // --- End of Access Logging & Notification ---

    // 3. Generate subscription content by calling the centralized generator
    const logger = new Logger();
    return generateSubscription(c, profile, false, logger);
});

// This route serves raw node content from a base64 encoded string
// It's used in remote mode to include manual nodes in subconverter requests
publicRoutes.get('/nodes', async (c) => {
    const base64_content = c.req.query('content');
    if (!base64_content) {
        return c.text('Missing content query parameter', 400);
    }
    try {
        const decodedContent = Buffer.from(base64_content, 'base64').toString('utf-8');
        return c.text(decodedContent);
    } catch (e) {
        console.error("Failed to decode base64 content from query:", e);
        return c.text('Invalid base64 content', 400);
    }
});

export default publicRoutes;