import { Hono } from 'hono';
import type { Env } from '../utils/types';
import { manualAuthMiddleware } from '../middleware/auth';
import { parseNodeLinks, ParsedNode } from '../../../src/utils/nodeParser';
import { applySubscriptionRules, parseSubscriptionContent } from './subscriptions';
import { fetchSubscriptionContent } from '../utils/network';
import { generateSubscription } from '../utils/profileGenerator';

const profiles = new Hono<{ Bindings: Env }>();

// --- START OF REFACTORED LOGIC ---

interface SelectedSource {
  type: 'subscription';
  sub: { id: string; name: string; url: string; group_id: string | null; };
}

interface StrategyResult {
  selectedSources: SelectedSource[];
  updatedPollingState: {
    polling_index?: number;
    group_polling_indices?: Record<string, number>;
  };
  strategy: string;
}

export const selectSourcesByStrategy = async (profile: any, allSubscriptions: any[], isDryRun: boolean = false): Promise<StrategyResult> => {
    const content = JSON.parse(profile.content || '{}');
    const airportOptions = content.airport_subscription_options || {};
    let activeSubscriptions = allSubscriptions ? [...allSubscriptions] : [];
    
    const selectedSources: SelectedSource[] = [];
    const updatedPollingState: StrategyResult['updatedPollingState'] = {};
    let strategy = airportOptions.strategy;
    if (!strategy) {
        if (airportOptions.use_all) strategy = 'all';
        else if (airportOptions.polling) strategy = 'polling';
        else if (airportOptions.random) strategy = 'random';
        else strategy = 'all'; // Default fallback
    }

    if (activeSubscriptions.length === 0) {
        return { selectedSources, updatedPollingState, strategy: 'none' };
    }

    // For remote mode, the logic remains the same: select URLs first.
    // The new threshold logic only applies to local parsing.
    if (content.generation_mode === 'remote') {
        if (strategy === 'random') {
            for (let i = activeSubscriptions.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [activeSubscriptions[i], activeSubscriptions[j]] = [activeSubscriptions[j], activeSubscriptions[i]];
            }
            selectedSources.push({ type: 'subscription', sub: activeSubscriptions[0] });
        } else if (strategy === 'polling') {
            const mode = airportOptions.polling_mode || 'hourly';
            strategy = `polling (${mode})`;

            if (mode === 'group_request') {
                const groupedSubs: Record<string, any[]> = {};
                for (const sub of activeSubscriptions) {
                    const groupId = sub.group_id || 'ungrouped';
                    if (!groupedSubs[groupId]) groupedSubs[groupId] = [];
                    groupedSubs[groupId].push(sub);
                }
                const groupPollingState = JSON.parse(profile.group_polling_indices || '{}');
                for (const groupId in groupedSubs) {
                    const subsInGroup = groupedSubs[groupId];
                    const startIndex = groupPollingState[groupId] || 0;
                    const selectedSubIndex = startIndex % subsInGroup.length;
                    selectedSources.push({ type: 'subscription', sub: subsInGroup[selectedSubIndex] });
                    if (!isDryRun) {
                        groupPollingState[groupId] = (selectedSubIndex + 1) % subsInGroup.length;
                    }
                }
                updatedPollingState.group_polling_indices = groupPollingState;
            } else if (mode === 'request') {
                const startIndex = profile.polling_index || 0;
                selectedSources.push({ type: 'subscription', sub: activeSubscriptions[startIndex % activeSubscriptions.length] });
                if (!isDryRun) {
                    updatedPollingState.polling_index = (startIndex + 1) % activeSubscriptions.length;
                }
            } else { // hourly
                const hour = new Date().getHours();
                selectedSources.push({ type: 'subscription', sub: activeSubscriptions[hour % activeSubscriptions.length] });
            }
        } else { // use_all
            for (const sub of activeSubscriptions) {
                selectedSources.push({ type: 'subscription', sub });
            }
        }
    } else {
        // For local mode, we always pass all subscriptions downstream to let generateProfileNodes handle the fetching logic.
        for (const sub of activeSubscriptions) {
            selectedSources.push({ type: 'subscription', sub });
        }
    }

    return { selectedSources, updatedPollingState, strategy };
};


export const applyAllRules = async (db: D1Database, userId: string, profileId: string, nodes: (ParsedNode & { id: string; raw: string; })[]): Promise<(ParsedNode & { id: string; raw: string; })[]> => {
    let processedNodes = [...nodes];

    const { results: profileRules } = await db.prepare(
        'SELECT * FROM profile_rules WHERE profile_id = ? AND user_id = ? AND enabled = 1 ORDER BY sort_order ASC'
    ).bind(profileId, userId).all<any>();

    if (profileRules && profileRules.length > 0) {
        processedNodes = applySubscriptionRules(processedNodes, profileRules);
    }

    return processedNodes;
};


export const generateProfileNodes = async (env: Env, executionCtx: ExecutionContext, profile: any, isDryRun: boolean = false): Promise<(ParsedNode & { id: string; raw: string; subscriptionName?: string; isManual?: boolean; group_name?: string; })[]> => {
    const content = JSON.parse(profile.content || '{}');
    const userId = profile.user_id;
    const airportOptions = content.airport_subscription_options || {};
    const timeout = airportOptions.timeout || 10;

    let allNodes: (ParsedNode & { id: string; raw: string; subscriptionName?: string; isManual?: boolean; group_name?: string; })[] = [];
    
    if (content.subscription_ids && content.subscription_ids.length > 0) {
        const subs = await env.DB.prepare(`SELECT * FROM subscriptions WHERE id IN (${content.subscription_ids.map(()=>'?').join(',')}) AND user_id = ?`).bind(...content.subscription_ids, userId).all<any>();
        
        const { selectedSources, updatedPollingState, strategy } = await selectSourcesByStrategy(profile, subs.results, isDryRun);

        if (strategy === 'polling (group_request)' && content.generation_mode === 'local') {
            const pollingThreshold = airportOptions.polling_threshold || 5;
            
            const groupedSubs: Record<string, any[]> = {};
            for (const source of selectedSources) {
                const groupId = source.sub.group_id || 'ungrouped';
                if (!groupedSubs[groupId]) groupedSubs[groupId] = [];
                groupedSubs[groupId].push(source.sub);
            }

            const groupPollingState = JSON.parse(profile.group_polling_indices || '{}');

            for (const groupId in groupedSubs) {
                const subsInGroup = groupedSubs[groupId];
                const startIndex = groupPollingState[groupId] || 0;
                let foundOne = false;

            for (let i = 0; i < Math.min(subsInGroup.length, pollingThreshold); i++) {
                const currentIndex = (startIndex + i) % subsInGroup.length;
                const currentSub = subsInGroup[currentIndex];
                
                const fetchedContent = await fetchSubscriptionContent(currentSub.url, timeout);
                if (fetchedContent) {
                    let nodes = parseSubscriptionContent(fetchedContent);
                    const nodesWithSubName = nodes.map(node => ({ ...node, subscriptionName: currentSub.name }));
                    allNodes.push(...nodesWithSubName);
                    
                    if (!isDryRun) {
                        groupPollingState[groupId] = (currentIndex + 1) % subsInGroup.length;
                    }
                    foundOne = true;
                    break;
                }
            }
            if (!foundOne) {
                console.warn(`[${groupId}] 在 ${pollingThreshold} 次尝试后，未能从该分组获取任何可用节点。`);
            }
        }
            if (Object.keys(groupPollingState).length > 0) {
                updatedPollingState.group_polling_indices = groupPollingState;
            }

        } else {
            const fetchPromises = selectedSources.map(async (source) => {
                if (source.type === 'subscription') {
                    const content = await fetchSubscriptionContent(source.sub.url, timeout);
                    if (content) {
                        return { ...source, content };
                    }
                }
                return null;
            });

            const fetchedSources = (await Promise.all(fetchPromises)).filter(Boolean);

            for (const source of fetchedSources) {
                if (source && source.content) {
                    let nodes = parseSubscriptionContent(source.content);
                    let combinedRules = [];

                    if (source.sub.group_id) {
                        const { results: groupRules } = await env.DB.prepare('SELECT * FROM subscription_group_rules WHERE group_id = ? AND user_id = ? AND enabled = 1 ORDER BY sort_order ASC').bind(source.sub.group_id, userId).all();
                        if (groupRules && groupRules.length > 0) {
                            combinedRules.push(...groupRules);
                        }
                    }

                    const { results: subRules } = await env.DB.prepare('SELECT * FROM subscription_rules WHERE subscription_id = ? AND user_id = ? AND enabled = 1 ORDER BY sort_order ASC').bind(source.sub.id, userId).all();
                    if (subRules && subRules.length > 0) {
                        combinedRules.push(...subRules);
                    }

                    if (combinedRules.length > 0) {
                        nodes = applySubscriptionRules(nodes, combinedRules);
                    }
                    
                    const nodesWithSubName = nodes.map(node => ({ ...node, subscriptionName: source.sub.name }));
                    allNodes.push(...nodesWithSubName);
                }
            }
        }
        
        if (!isDryRun && Object.keys(updatedPollingState).length > 0) {
            let setClauses = [];
            let bindings: (string | number | undefined)[] = [];
            if (updatedPollingState.polling_index !== undefined) {
                setClauses.push('polling_index = ?');
                bindings.push(updatedPollingState.polling_index);
            }
            if (updatedPollingState.group_polling_indices !== undefined) {
                setClauses.push('group_polling_indices = ?');
                bindings.push(JSON.stringify(updatedPollingState.group_polling_indices));
            }
            
            if (setClauses.length > 0) {
                const query = `UPDATE profiles SET ${setClauses.join(', ')} WHERE id = ?`;
                bindings.push(profile.id);
                executionCtx.waitUntil(env.DB.prepare(query).bind(...bindings).run());
            }
        }
    }

    if (content.node_ids && content.node_ids.length > 0) {
        const { results: manualNodes } = await env.DB.prepare(`
            SELECT n.*, g.name as group_name FROM nodes n
            LEFT JOIN node_groups g ON n.group_id = g.id
            WHERE n.id IN (${content.node_ids.map(()=>'?').join(',')}) AND n.user_id = ?
        `).bind(...content.node_ids, userId).all<any>();

        const parsedManualNodes = manualNodes.map((n: any) => ({
            ...parseNodeLinks(n.link)[0],
            id: n.id,
            raw: n.link,
            group_name: n.group_name,
            isManual: true,
        }));
        allNodes.push(...parsedManualNodes);
    }

    allNodes = await applyAllRules(env.DB, userId, profile.id, allNodes);

    const prefixSettings = content.node_prefix_settings || {};
    if (prefixSettings.enable_subscription_prefix || prefixSettings.manual_node_prefix || prefixSettings.enable_group_name_prefix) {
        let prefixAppliedCount = 0;
        allNodes = allNodes.map(node => {
            if (prefixSettings.enable_subscription_prefix && node.subscriptionName) {
                prefixAppliedCount++;
                return { ...node, name: `${node.subscriptionName} - ${node.name}` };
            }
            if (node.isManual) {
                if (prefixSettings.enable_group_name_prefix && node.group_name) {
                    prefixAppliedCount++;
                    return { ...node, name: `${node.group_name} - ${node.name}` };
                }
                if (prefixSettings.manual_node_prefix) {
                    prefixAppliedCount++;
                    return { ...node, name: `${prefixSettings.manual_node_prefix} - ${node.name}` };
                }
            }
            return node;
        });
    }
    
    return allNodes;
};

// --- END OF REFACTORED LOGIC ---


// This is a public endpoint, no auth on this specific route
profiles.get('/:identifier/subscribe', async (c) => {
    c.status(410); // Gone
    return c.text('This subscription link format is deprecated. Please use the new format: /s/{token}/{alias}/subscribe');
});


// All other routes below this line require auth
profiles.use('*', manualAuthMiddleware);

profiles.get('/:id/preview-nodes', async (c) => {
    const user = c.get('jwtPayload');
    const { id } = c.req.param();
    const profile = await c.env.DB.prepare('SELECT * FROM profiles WHERE id = ? AND user_id = ?').bind(id, user.id).first<any>();

    if (!profile) {
        return c.json({ success: false, message: 'Profile not found' }, 404);
    }
    
    // The preview route now calls the centralized generator with isDryRun = true
    return generateSubscription(c, profile, true);
});

profiles.get('/', async (c) => {
    const user = c.get('jwtPayload');
    const { results } = await c.env.DB.prepare('SELECT * FROM profiles WHERE user_id = ?').bind(user.id).all<any>();
    
    const expandedResults = results.map(profile => {
        try {
            const content = JSON.parse(profile.content || '{}');
            return { ...profile, ...content };
        } catch (e) {
            console.error(`Failed to parse content for profile ${profile.id}:`, e);
            return profile;
        }
    });

    return c.json({ success: true, data: expandedResults });
});

profiles.post('/', async (c) => {
    const user = c.get('jwtPayload');
    const body = await c.req.json<any>();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    if (!body.name || typeof body.name !== 'string' || body.name.trim() === '') {
        return c.json({ success: false, message: 'Profile name is required.' }, 400);
    }

    const name = body.name.trim();
    const alias = body.alias || null;
    const content = JSON.parse(body.content || '{}');

    const contentPayload = {
        subscription_ids: content.subscription_ids,
        node_ids: content.node_ids,
        node_prefix_settings: content.node_prefix_settings,
        airport_subscription_options: content.airport_subscription_options,
        subconverter_backend_id: content.subconverter_backend_id,
        subconverter_config_id: content.subconverter_config_id,
        generation_mode: content.generation_mode || 'local',
    };

    await c.env.DB.prepare(
        `INSERT INTO profiles (id, user_id, name, alias, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, user.id, name, alias, JSON.stringify(contentPayload), now, now).run();
    
    return c.json({ success: true, data: { id } }, 201);
});

profiles.get('/:id', async (c) => {
    const user = c.get('jwtPayload');
    const { id } = c.req.param();
    const profile: any = await c.env.DB.prepare('SELECT * FROM profiles WHERE id = ? AND user_id = ?').bind(id, user.id).first();
    if (!profile) return c.json({ success: false, message: 'Profile not found' }, 404);

    try {
        const content = JSON.parse(profile.content || '{}');
        const expandedProfile = { ...profile, ...content };
        return c.json({ success: true, data: expandedProfile });
    } catch (e) {
        console.error(`Failed to parse content for profile ${id}:`, e);
        return c.json({ success: true, data: profile });
    }
});

profiles.put('/:id', async (c) => {
    const user = c.get('jwtPayload');
    const { id } = c.req.param();
    const body = await c.req.json<any>();
    const now = new Date().toISOString();

    if (!body.name || typeof body.name !== 'string' || body.name.trim() === '') {
        return c.json({ success: false, message: 'Profile name is required.' }, 400);
    }

    const name = body.name.trim();
    const alias = body.alias || null;
    const content = JSON.parse(body.content || '{}');

    const contentPayload = {
        subscription_ids: content.subscription_ids,
        node_ids: content.node_ids,
        node_prefix_settings: content.node_prefix_settings,
        airport_subscription_options: content.airport_subscription_options,
        subconverter_backend_id: content.subconverter_backend_id,
        subconverter_config_id: content.subconverter_config_id,
        generation_mode: content.generation_mode || 'local',
    };

    await c.env.DB.prepare(
        `UPDATE profiles SET name = ?, alias = ?, content = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`
    ).bind(name, alias, JSON.stringify(contentPayload), now, id, user.id).run();
    
    return c.json({ success: true });
});

profiles.delete('/:id', async (c) => {
    const user = c.get('jwtPayload');
    const { id } = c.req.param();
    await c.env.DB.prepare('DELETE FROM profiles WHERE id = ? AND user_id = ?').bind(id, user.id).run();
    return c.json({ success: true });
});

export default profiles;