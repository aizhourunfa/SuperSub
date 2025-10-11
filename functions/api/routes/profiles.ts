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

// Represents a set of candidate subscriptions for a single group in group_polling mode
export interface CandidateSet {
  candidates: any[];
  totalInGroup: number;
  startIndex: number;
}

// The result of the strategy selection
export type StrategyResult = {
  strategy: string;
  updatedPollingState: {
    polling_index?: number;
    group_polling_indices?: Record<string, number>;
  };
} & ({
  // For group_request, we return a map of candidate sets
  type: 'candidates';
  candidateSets: Map<string, CandidateSet>;
} | {
  // For all other strategies, we return the final selected sources
  type: 'selection';
  selectedSources: SelectedSource[];
});


export const selectSourcesByStrategy = async (c: any, profile: any, isDryRun: boolean = false): Promise<StrategyResult> => {
    const db = c.env.DB;
    const userId = profile.user_id;
    const content = JSON.parse(profile.content || '{}');
    const airportOptions = content.airport_subscription_options || {};
    const subIds = content.subscription_ids || [];

    const updatedPollingState: StrategyResult['updatedPollingState'] = {};
    
    let strategy = airportOptions.strategy;
    if (!strategy) {
        if (airportOptions.use_all) strategy = 'all';
        else if (airportOptions.polling) strategy = 'polling';
        else if (airportOptions.random) strategy = 'random';
        else strategy = 'all'; // Default fallback
    }

    if (subIds.length === 0) {
        return { type: 'selection', selectedSources: [], updatedPollingState, strategy: 'none' };
    }

    // --- Group Polling Strategy (Optimized for large scale) ---
    if (strategy === 'polling' && airportOptions.polling_mode === 'group_request') {
        const CHUNK_SIZE = 50; // Safe chunk size for IN clause
        const pollingThreshold = airportOptions.polling_threshold || 5;
        const groupPollingState = JSON.parse(profile.group_polling_indices || '{}');

        // 1. Get group counts for all *selected* subscriptions, in chunks
        const groupCountsMap = new Map<string, number>();
        for (let i = 0; i < subIds.length; i += CHUNK_SIZE) {
            const chunk = subIds.slice(i, i + CHUNK_SIZE);
            const groupCountsQuery = `
                SELECT group_id, COUNT(*) as total
                FROM subscriptions
                WHERE id IN (${chunk.map(() => '?').join(',')}) AND user_id = ?
                GROUP BY group_id
            `;
            const { results: chunkGroupCounts } = await db.prepare(groupCountsQuery).bind(...chunk, userId).all();
            if (chunkGroupCounts) {
                for (const row of chunkGroupCounts as any[]) {
                    const groupId = row.group_id || 'ungrouped';
                    groupCountsMap.set(groupId, (groupCountsMap.get(groupId) || 0) + row.total);
                }
            }
        }

        if (groupCountsMap.size === 0) {
            return { type: 'selection', selectedSources: [], updatedPollingState, strategy: 'polling (group_request)' };
        }

        const candidateSets = new Map<string, CandidateSet>();

        // 2. For each group, fetch a small "candidate set" using pagination
        for (const [groupId, totalInGroup] of groupCountsMap.entries()) {
            const startIndex = groupPollingState[groupId] || 0;
            const effectiveStartIndex = startIndex % totalInGroup;

            const candidatesQuery = `
                SELECT id, name, url, group_id
                FROM subscriptions
                WHERE user_id = ? AND ${groupId === 'ungrouped' ? 'group_id IS NULL' : 'group_id = ?'}
                ORDER BY id
                LIMIT ? OFFSET ?
            `;
            
            const queryParams: any[] = [userId];
            if (groupId !== 'ungrouped') {
                queryParams.push(groupId);
            }
            queryParams.push(pollingThreshold, effectiveStartIndex);

            const { results: candidates } = await db.prepare(candidatesQuery).bind(...queryParams).all();
            
            if (candidates && candidates.length > 0) {
                candidateSets.set(groupId, {
                    candidates,
                    totalInGroup,
                    startIndex: effectiveStartIndex
                });
            }
        }
        
        return {
            type: 'candidates',
            candidateSets,
            updatedPollingState, // This will be populated in the next step (generateProfileNodes)
            strategy: 'polling (group_request)'
        };
    }

    // --- Other Strategies (Still require fetching all subs, but can be optimized if needed) ---
    const CHUNK_SIZE = 50;
    let allSubs: any[] = [];
    for (let i = 0; i < subIds.length; i += CHUNK_SIZE) {
        const chunk = subIds.slice(i, i + CHUNK_SIZE);
        const query = `SELECT * FROM subscriptions WHERE id IN (${chunk.map(() => '?').join(',')}) AND user_id = ?`;
        const { results: subsInChunk } = await db.prepare(query).bind(...chunk, userId).all();
        if (subsInChunk) {
            allSubs = allSubs.concat(subsInChunk);
        }
    }

    let selectedSources: SelectedSource[] = [];

    if (strategy === 'random') {
        const groupedSubs: Record<string, any[]> = {};
        for (const sub of allSubs) {
            const groupId = sub.group_id || 'ungrouped';
            if (!groupedSubs[groupId]) groupedSubs[groupId] = [];
            groupedSubs[groupId].push(sub);
        }
        for (const groupId in groupedSubs) {
            const subsInGroup = groupedSubs[groupId];
            const randomIndex = Math.floor(Math.random() * subsInGroup.length);
            selectedSources.push({ type: 'subscription', sub: subsInGroup[randomIndex] });
        }
    } else if (strategy === 'polling') {
        const mode = airportOptions.polling_mode || 'hourly';
        strategy = `polling (${mode})`;

        if (mode === 'request') {
            const startIndex = profile.polling_index || 0;
            selectedSources.push({ type: 'subscription', sub: allSubs[startIndex % allSubs.length] });
            updatedPollingState.polling_index = (startIndex + 1) % allSubs.length;
        } else { // hourly
            const hour = new Date().getHours();
            selectedSources.push({ type: 'subscription', sub: allSubs[hour % allSubs.length] });
        }
    } else { // 'all' or default
        for (const sub of allSubs) {
            selectedSources.push({ type: 'subscription', sub });
        }
    }

    return { type: 'selection', selectedSources, updatedPollingState, strategy };
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
        // Mock Hono context for selectSourcesByStrategy
        const mockContext = {
            env: { DB: env.DB },
            get: (key: string) => (key === 'jwtPayload' ? { id: userId } : undefined),
        };

        const strategyResult = await selectSourcesByStrategy(mockContext, profile, isDryRun);
        const { updatedPollingState, strategy } = strategyResult;

        if (strategy === 'polling (group_request)' && strategyResult.type === 'candidates' && content.generation_mode === 'local') {
            const pollingInterval = airportOptions.polling_interval || 200;
            const groupPollingState = JSON.parse(profile.group_polling_indices || '{}');
            
            const findAvailableSubInGroup = async (groupId: string, candidateSet: CandidateSet) => {
                const promises = candidateSet.candidates.map((sub, index) => {
                    return new Promise<any>(async (resolve, reject) => {
                        try {
                            await new Promise(res => setTimeout(res, index * pollingInterval));
                            const fetchedContent = await fetchSubscriptionContent(sub.url, timeout);
                            if (fetchedContent) {
                                resolve({ content: fetchedContent, sub, index });
                            } else {
                                reject(new Error(`Content empty for ${sub.url}`));
                            }
                        } catch (error) {
                            reject(error);
                        }
                    });
                });

                try {
                    const firstSuccess = await Promise.any(promises);
                    let nodes = parseSubscriptionContent(firstSuccess.content);
                    const nodesWithSubName = nodes.map(node => ({ ...node, subscriptionName: firstSuccess.sub.name }));
                    allNodes.push(...nodesWithSubName);

                    const newIndex = (candidateSet.startIndex + firstSuccess.index + 1) % candidateSet.totalInGroup;
                    groupPollingState[groupId] = newIndex;

                } catch (error) {
                    // All candidates failed, do nothing, the group will not have nodes this time.
                }
            };

            const groupPromises = Array.from(strategyResult.candidateSets.entries()).map(([groupId, cs]) => findAvailableSubInGroup(groupId, cs));
            await Promise.all(groupPromises);
            
            if (Object.keys(groupPollingState).length > 0) {
                updatedPollingState.group_polling_indices = groupPollingState;
            }

        } else if (strategyResult.type === 'selection') {
            const { selectedSources } = strategyResult;
            const fetchPromises = selectedSources.map(async (source: any) => {
                if (source.type === 'subscription') {
                    const content = await fetchSubscriptionContent(source.sub.url, timeout);
                    if (content) {
                        return { ...source, content };
                    }
                }
                return null;
            });

            const fetchedSources = (await Promise.all(fetchPromises)).filter(Boolean);

            for (const source of fetchedSources as any[]) {
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
                    
                    const nodesWithSubName = nodes.map((node: any) => ({ ...node, subscriptionName: source.sub.name }));
                    allNodes.push(...nodesWithSubName);
                }
            }
        }
        
        if (Object.keys(updatedPollingState).length > 0) {
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