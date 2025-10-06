import type { Context, Next } from 'hono';
import { verify } from 'hono/jwt';
import type { Env } from '../utils/types';

// Custom authentication middleware
export const manualAuthMiddleware = async (c: Context<{ Bindings: Env }>, next: Next) => {
  let token = '';
  const authHeader = c.req.header('Authorization');
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else {
    const queryToken = c.req.query('token');
    if (queryToken) {
      token = queryToken;
    }
  }

  if (!token || token === 'null') {
    return c.json({ success: false, message: 'Unauthorized: Missing or invalid token' }, 401);
  }

  const secret = c.env.JWT_SECRET;
  if (!secret) {
    return c.json({ success: false, message: 'Internal Server Error: JWT secret not configured' }, 500);
  }

  try {
    const payload = await verify(token, secret);
    c.set('jwtPayload', payload);
    await next();
  } catch (error) {
    return c.json({ success: false, message: 'Unauthorized: Invalid token' }, 401);
  }
};

// Middleware to check for admin role
export const adminAuthMiddleware = async (c: Context, next: Next) => {
  const payload = c.get('jwtPayload');

  if (!payload || payload.role !== 'admin') {
    return c.json({ success: false, message: 'Forbidden: Administrator access required' }, 403);
  }

  await next();
};