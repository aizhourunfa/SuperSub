import { Buffer } from 'node:buffer';
import type { Env } from './types';
import { Context } from 'hono';
import { generateProfileNodes, selectSourcesByStrategy, applyAllRules } from '../routes/profiles';
import { regenerateLink, parseNodeLinks, ParsedNode } from '../../../src/utils/nodeParser';
import { parseSubscriptionContent, userAgents } from '../routes/subscriptions';
import { Logger } from './logger';

export const generateSubscription = async (c: any, profile: any, isDryRun: boolean = false, logger: Logger) => {
    const content = JSON.parse(profile.content || '{}');
    logger.info(`开始处理配置文件: "${profile.name}"`, { profileId: profile.id });

    let result: any;

    try {
        const mainLogic = async () => {
            const userId = profile.user_id;
            const userAgent = c.req.header('User-Agent') || '';
            const query = c.req.query();

            let targetClient = 'base64';
            if (query.clash) targetClient = 'clash';
            if (query.singbox || query.sb) targetClient = 'singbox';
            if (query.surge) targetClient = 'surge';
            if (query.v2ray) targetClient = 'v2ray';

            if (targetClient === 'base64' && !query.b64) {
                const { results: uaMappings } = await c.env.DB.prepare('SELECT ua_keyword, client_type FROM ua_mappings WHERE is_enabled = 1').all();
                for (const mapping of uaMappings as any[]) {
                    if (userAgent.toLowerCase().includes(mapping.ua_keyword.toLowerCase())) {
                        targetClient = mapping.client_type;
                        logger.info(`通过 User-Agent 自动识别客户端为: ${targetClient}`, { userAgent });
                        break;
                    }
                }
            }
            logger.info(`最终目标客户端: ${targetClient}`);

            let subconverterUrlInput = '';
            let isLocalContentBase64 = false;
            let localContent = '';
            const generationMode = content.generation_mode || 'local';
            logger.info(`解析模式: ${generationMode}`);

            if (generationMode === 'remote') {
                let subscriptionUrls: string[] = [];
                let manualNodeLinks: string[] = [];

                if (content.subscription_ids && content.subscription_ids.length > 0) {
                    logger.info('开始根据策略选择订阅源...');
                    const strategyResult = await selectSourcesByStrategy(c, profile, isDryRun, logger);
                    let { updatedPollingState, strategy } = strategyResult;
                    logger.success(`订阅选择策略: ${strategy}`);

                    if (strategyResult.type === 'selection') {
                        subscriptionUrls.push(...strategyResult.selectedSources.map((s: any) => s.sub.url));
                        logger.info(`选择了 ${strategyResult.selectedSources.length} 个订阅源`, { urls: subscriptionUrls });
                    } else if (strategyResult.type === 'candidates') {
                        logger.info('正在处理 "分组轮询" 策略 (远程模式)...');
                        const groupPollingState = JSON.parse(profile.group_polling_indices || '{}');
                        const groupPromises = Array.from(strategyResult.candidateSets.entries()).map(async ([groupId, cs]) => {
                            const query = `
                                SELECT url FROM subscriptions
                                WHERE user_id = ? AND ${groupId === 'ungrouped' ? 'group_id IS NULL' : 'group_id = ?'}
                                ORDER BY id
                                LIMIT 1 OFFSET ?
                            `;
                            const queryParams: any[] = [userId];
                            if (groupId !== 'ungrouped') queryParams.push(groupId);
                            queryParams.push(cs.startIndex);
                            
                            const result = await c.env.DB.prepare(query).bind(...queryParams).first();
                            if (result) {
                                logger.success(`分组 "${groupId}" 选择了订阅: ${result.url}`);
                                subscriptionUrls.push(result.url);
                                const newIndex = (cs.startIndex + 1) % cs.totalInGroup;
                                groupPollingState[groupId] = newIndex;
                            } else {
                                logger.warn(`分组 "${groupId}" 在轮询中没有找到可用的订阅。`);
                            }
                        });

                        await Promise.all(groupPromises);
                        
                        if (Object.keys(groupPollingState).length > 0) {
                            updatedPollingState = { ...updatedPollingState, group_polling_indices: groupPollingState };
                        }
                    }
                    
                    if (Object.keys(updatedPollingState).length > 0 && !isDryRun) {
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
                            const updateQuery = `UPDATE profiles SET ${setClauses.join(', ')} WHERE id = ?`;
                            bindings.push(profile.id);
                            logger.info('正在更新数据库中的轮询状态...', { state: updatedPollingState });
                            c.executionCtx.waitUntil(c.env.DB.prepare(updateQuery).bind(...bindings).run());
                        }
                    }
                } else {
                    logger.info('配置文件中未包含任何订阅。');
                }

                if (content.node_ids && content.node_ids.length > 0) {
                    logger.info(`准备合并 ${content.node_ids.length} 个手动添加的节点...`);
                    const { results: manualNodes } = await c.env.DB.prepare(`SELECT link FROM nodes WHERE id IN (${content.node_ids.map(()=>'?').join(',')}) AND user_id = ?`).bind(...content.node_ids, userId).all();
                    manualNodeLinks = (manualNodes as any[]).map(n => n.link);
                    logger.success(`成功获取 ${manualNodeLinks.length} 个手动节点的链接。`);
                }

                const finalUrlParts = [...subscriptionUrls];
                if (manualNodeLinks.length > 0) {
                    const manualNodesContent = manualNodeLinks.join('\n');
                    const base64ManualNodes = Buffer.from(manualNodesContent).toString('base64');
                    const encodedContent = encodeURIComponent(base64ManualNodes);

                    const selfUrl = new URL(c.req.url);
                    const nodesUrl = `${selfUrl.origin}/api/public/nodes?content=${encodedContent}`;
                    logger.info('已将手动节点转换为一个临时的 base64 订阅链接', { url: nodesUrl });
                    finalUrlParts.push(nodesUrl);
                }
                
                if (finalUrlParts.length > 0) {
                    subconverterUrlInput = finalUrlParts.join('|');
                    logger.info('最终组合的订阅链接已生成', { combinedUrl: subconverterUrlInput });
                }

            } else { // 'local' mode
                const allNodes = await generateProfileNodes(c.env, c.executionCtx, profile, isDryRun, logger);
                
                if (isDryRun) {
                    const analysis = {
                        total: allNodes.length,
                        protocols: allNodes.reduce((acc, node) => {
                            const protocol = node.protocol || 'unknown';
                            acc[protocol] = (acc[protocol] || 0) + 1;
                            return acc;
                        }, {} as Record<string, number>),
                        regions: allNodes.reduce((acc, node) => {
                            const match = node.name.match(/\[(.*?)\]|\((.*?)\)|(香港|澳门|台湾|新加坡|日本|美国|英国|德国|法国|韩国|俄罗斯|IEPL|IPLC)/);
                            const region = match ? (match[1] || match[2] || match[3] || 'Unknown') : 'Unknown';
                            acc[region] = (acc[region] || 0) + 1;
                            return acc;
                        }, {} as Record<string, number>),
                    };
                    logger.success(`预览生成完成，共 ${allNodes.length} 个节点。`);
                    return { type: 'json', payload: { success: true, data: { mode: 'local', nodes: allNodes, analysis: analysis, logs: logger.logs } } };
                }

                if (allNodes.length === 0) {
                    logger.warn('没有找到任何可用节点。');
                    return { type: 'text', payload: 'No nodes found for this profile.', status: 404 };
                }
                
                localContent = allNodes.map(regenerateLink).filter(Boolean).join('\n');
                logger.success(`本地内容生成完成，共 ${allNodes.length} 个节点。`);
                
                if (query.b64 || targetClient === 'base64') {
                    logger.info('将直接返回 Base64 编码的内容。');
                    isLocalContentBase64 = true;
                } else {
                    const currentUrl = new URL(c.req.url);
                    currentUrl.searchParams.set('b64', '1');
                    subconverterUrlInput = `${currentUrl.toString()}&_t=${Date.now()}`;
                    logger.info('将通过 Subconverter 处理本地生成的节点列表。', { subconverterUrlInput });
                }
            }

            if (isDryRun) {
                if (generationMode === 'remote') {
                    const finalUrls = subconverterUrlInput ? subconverterUrlInput.split('|') : [];
                    logger.info(`远程模式预览: 准备获取并解析 ${finalUrls.length} 个链接...`, { urls: finalUrls });
                    
                    if (finalUrls.length === 0) {
                        logger.warn('远程模式预览: 没有可供解析的链接。');
                        return { type: 'json', payload: { success: true, data: { mode: 'remote', nodes: [], analysis: { total: 0, protocols: {}, regions: {} }, logs: logger.logs } } };
                    }

                    const fetchPromises = finalUrls.map(url =>
                        fetch(url, { headers: { 'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)] } })
                        .then(res => {
                            if (!res.ok) {
                                logger.error(`获取预览URL失败: HTTP状态 ${res.status}`, { url });
                                return '';
                            }
                            return res.text();
                        })
                        .catch(err => {
                            logger.error(`获取预览URL时发生网络错误: ${err.message}`, { url });
                            return '';
                        })
                    );

                    const contents = await Promise.all(fetchPromises);
                    let allNodes: (ParsedNode & { id: string; raw: string; })[] = [];

                    for (const content of contents) {
                        if (content) {
                            const nodes = parseSubscriptionContent(content);
                            allNodes.push(...nodes);
                        }
                    }
                    logger.info(`远程模式预览: 初始解析得到 ${allNodes.length} 个节点。`);
                    
                    const finalNodes = await applyAllRules(c.env.DB, profile.user_id, profile.id, allNodes, logger);
                    
                    const analysis = {
                        total: finalNodes.length,
                        protocols: finalNodes.reduce((acc: Record<string, number>, node: ParsedNode) => {
                            const protocol = node.protocol || 'unknown';
                            acc[protocol] = (acc[protocol] || 0) + 1;
                            return acc;
                        }, {}),
                        regions: finalNodes.reduce((acc: Record<string, number>, node: ParsedNode) => {
                            const match = node.name.match(/\[(.*?)\]|\((.*?)\)|(香港|澳门|台湾|新加坡|日本|美国|英国|德国|法国|韩国|俄罗斯|IEPL|IPLC)/);
                            const region = match ? (match[1] || match[2] || match[3] || 'Unknown') : 'Unknown';
                            acc[region] = (acc[region] || 0) + 1;
                            return acc;
                        }, {}),
                    };
                    logger.success(`远程模式预览完成，最终获得 ${finalNodes.length} 个节点。`);
                    return { type: 'json', payload: { success: true, data: { mode: 'remote', nodes: finalNodes, analysis: analysis, logs: logger.logs } } };
                }
                logger.error('预览逻辑出现未处理的错误。');
                return { type: 'text', payload: '预览逻辑出现未处理的错误。', status: 500 };
            }

            if (isLocalContentBase64) {
                return { type: 'text', payload: Buffer.from(localContent, 'utf-8').toString('base64') };
            }

            if (subconverterUrlInput && (targetClient !== 'base64' || generationMode === 'remote')) {
                let finalTargetClient = targetClient;
                if (targetClient === 'base64' && generationMode === 'remote') {
                    finalTargetClient = 'clash'; // 远程模式若未指定客户端，则默认为 clash
                    logger.info(`远程模式未指定客户端，默认使用: ${finalTargetClient}`);
                }
                logger.info(`准备请求 Subconverter...`, { target: finalTargetClient });
                const backend = await c.env.DB.prepare("SELECT url FROM subconverter_assets WHERE id = ?").bind(content.subconverter_backend_id).first();
                const config = await c.env.DB.prepare("SELECT url FROM subconverter_assets WHERE id = ?").bind(content.subconverter_config_id).first();

                if (!backend || !config) {
                    logger.error('无法找到 Subconverter 后端或配置文件。');
                    return { type: 'text', payload: 'Subconverter 后端或配置文件未找到。', status: 500 };
                }
                logger.info('已找到 Subconverter 后端和配置文件。', { backendUrl: (backend as any).url, configUrl: (config as any).url });

                const targetUrl = new URL((backend as any).url + '/sub');
                targetUrl.searchParams.set('target', finalTargetClient);
                targetUrl.searchParams.set('url', subconverterUrlInput);
                targetUrl.searchParams.set('config', (config as any).url);
                targetUrl.searchParams.set('filename', profile.name);
                
                logger.info('向 Subconverter 发起请求...', { url: targetUrl.toString() });
                const subResponse = await fetch(targetUrl.toString(), { headers: { 'User-Agent': userAgent } });
                
                if (!subResponse.ok) {
                    const errorText = await subResponse.text();
                    logger.error('Subconverter 请求失败。', { error: errorText });
                    return { type: 'text', payload: `从 subconverter 生成失败: ${errorText}`, status: 502 };
                }
                logger.success('Subconverter 请求成功，正在返回订阅流。');
                return { type: 'stream', payload: subResponse };
            }

            if (!subconverterUrlInput && !localContent) {
                logger.warn('没有为指定的客户端生成任何内容。');
                return { type: 'text', payload: '没有为指定的客户端生成任何内容。', status: 404 };
            }
            
            logger.error('没有为指定的客户端生成任何内容。');
            return { type: 'text', payload: '没有为指定的客户端生成任何内容。', status: 404 };
        };

        result = await mainLogic();

    } catch (e: any) {
        logger.error(`处理配置文件 '${profile.name}' 时发生致命错误`, { error: e.message, stack: e.stack });
        result = { type: 'text', payload: `内部服务器错误: ${e.message}`, status: 500 };
    }

    // 最终响应处理
    if (!result) {
        return c.text('未知错误导致没有响应生成。', 500);
    }

    switch (result.type) {
        case 'json':
            return c.json(result.payload, result.status);
        case 'text':
            return c.text(result.payload, result.status);
        case 'stream':
            // Hono v3+ a可以直接返回 Response 对象
            // payload is already a Response object
            return result.payload;
        default:
            return c.text('未知的响应类型。', 500);
    }
};