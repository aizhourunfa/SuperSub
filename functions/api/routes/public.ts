import { Hono } from 'hono';
import { Buffer } from 'node:buffer';
import type { AppContext } from '../utils/types';
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

    // 3. Generate subscription content by calling the centralized generator
    // The notification logic is now inside generateSubscription
    const logger = new Logger();
    return generateSubscription(c, profile, user, true, false, logger);
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