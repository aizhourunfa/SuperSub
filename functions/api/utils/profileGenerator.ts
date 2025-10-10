import { Buffer } from 'node:buffer';
import type { Env } from './types';
import { Context } from 'hono';
import { generateProfileNodes, selectSourcesByStrategy, applyAllRules } from '../routes/profiles';
import { regenerateLink, parseNodeLinks, ParsedNode } from '../../../src/utils/nodeParser';
import { parseSubscriptionContent, userAgents } from '../routes/subscriptions';
import { Logger } from './logger';

export const generateSubscription = async (c: any, profile: any, isDryRun: boolean = false) => {
    const content = JSON.parse(profile.content || '{}');
    const logger = new Logger({ silent: !content.enable_logging });

    let result: any;

    try {
        const mainLogic = async () => {
            logger.step('初始化');
            const userId = profile.user_id;
            const userAgent = c.req.header('User-Agent') || '';
            const query = c.req.query();

            logger.info('开始生成配置文件...', {
                '配置文件': profile.name,
                '别名': profile.alias || 'N/A',
                '生成模式': content.generation_mode || 'local',
                '是否预览': isDryRun,
            });

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
                        break;
                    }
                }
            }
            logger.info('客户端探测完毕。', { 'User-Agent': userAgent, '目标客户端': targetClient });

            let subconverterUrlInput = '';
            let isLocalContentBase64 = false;
            let localContent = '';

            if (content.generation_mode === 'remote') {
                logger.step('远程模式');
                let subscriptionUrls: string[] = [];
                let manualNodeLinks: string[] = [];

                if (content.subscription_ids && content.subscription_ids.length > 0) {
                    const subs = await c.env.DB.prepare(`SELECT * FROM subscriptions WHERE id IN (${content.subscription_ids.map(()=>'?').join(',')}) AND user_id = ?`).bind(...content.subscription_ids, userId).all();
                    const { selectedSources, updatedPollingState, strategy } = await selectSourcesByStrategy(profile, subs.results, logger, isDryRun);
                    
                    logger.info(`订阅选择策略: '${strategy}'`, {
                        '输入订阅数': subs.results.length,
                        '选定订阅数': selectedSources.length,
                    });

                    subscriptionUrls.push(...selectedSources.map(s => s.sub.url));
                    
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
                            const updateQuery = `UPDATE profiles SET ${setClauses.join(', ')} WHERE id = ?`;
                            bindings.push(profile.id);
                            c.executionCtx.waitUntil(c.env.DB.prepare(updateQuery).bind(...bindings).run());
                        }
                    }
                }

                if (content.node_ids && content.node_ids.length > 0) {
                    const { results: manualNodes } = await c.env.DB.prepare(`SELECT link FROM nodes WHERE id IN (${content.node_ids.map(()=>'?').join(',')}) AND user_id = ?`).bind(...content.node_ids, userId).all();
                    manualNodeLinks = (manualNodes as any[]).map(n => n.link);
                    logger.info(`已添加 ${manualNodes.length} 个手动节点。`);
                }

                const finalUrlParts = [...subscriptionUrls];
                if (manualNodeLinks.length > 0) {
                    const manualNodesContent = manualNodeLinks.join('\n');
                    const base64ManualNodes = Buffer.from(manualNodesContent).toString('base64');
                    const encodedContent = encodeURIComponent(base64ManualNodes);

                    const selfUrl = new URL(c.req.url);
                    const nodesUrl = `${selfUrl.origin}/api/public/nodes?content=${encodedContent}`;
                    
                    finalUrlParts.push(nodesUrl);
                    logger.info(`已为手动节点生成自引用URL。`, { url: nodesUrl });
                }
                
                if (finalUrlParts.length > 0) {
                    subconverterUrlInput = finalUrlParts.join('|');
                    logger.info(`已创建用于 Subconverter 的最终合并URL。`, { url: subconverterUrlInput });
                }

            } else { // 'local' mode
                logger.step('本地模式');
                const allNodes = await generateProfileNodes(c.env, c.executionCtx, profile, logger, isDryRun);
                
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
                    logger.step('生成预览');
                    logger.success('本地模式预览生成成功。');
                    return { type: 'json', payload: { success: true, data: { mode: 'local', nodes: allNodes, analysis: analysis } } };
                }

                if (allNodes.length === 0) return { type: 'text', payload: 'No nodes found for this profile.', status: 404 };
                
                localContent = allNodes.map(regenerateLink).filter(Boolean).join('\n');
                
                if (query.b64 || targetClient === 'base64') {
                    isLocalContentBase64 = true;
                } else {
                    const currentUrl = new URL(c.req.url);
                    currentUrl.searchParams.set('b64', '1');
                    subconverterUrlInput = `${currentUrl.toString()}&_t=${Date.now()}`;
                    logger.info(`已为本地模式生成自引用URL。`, { url: subconverterUrlInput });
                }
            }

            logger.step('最终生成');

            if (isDryRun) {
                if (content.generation_mode === 'remote') {
                    logger.step('生成预览 (远程模式)');
                    const finalUrls = subconverterUrlInput ? subconverterUrlInput.split('|') : [];
                    
                    if (finalUrls.length === 0) {
                        logger.warn('没有可用于远程预览的URL。');
                        return { type: 'json', payload: { success: true, data: { mode: 'remote', nodes: [], analysis: { total: 0, protocols: {}, regions: {} } } } };
                    }

                    logger.info(`正在从 ${finalUrls.length} 个URL获取内容用于预览...`);
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
                    
                    logger.info(`从 ${finalUrls.length} 个源中获取并解析了 ${allNodes.length} 个节点。`);

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
                    logger.success('远程模式预览生成成功。');
                    return { type: 'json', payload: { success: true, data: { mode: 'remote', nodes: finalNodes, analysis: analysis } } };
                }
                return { type: 'text', payload: '预览逻辑出现未处理的错误。', status: 500 };
            }

            if (isLocalContentBase64) {
                logger.info('动作: 直接返回 base64 编码的本地内容。');
                return { type: 'text', payload: Buffer.from(localContent, 'utf-8').toString('base64') };
            }

            if (subconverterUrlInput && (targetClient !== 'base64' || content.generation_mode === 'remote')) {
                let finalTargetClient = targetClient;
                if (targetClient === 'base64' && content.generation_mode === 'remote') {
                    finalTargetClient = 'clash'; // 远程模式若未指定客户端，则默认为 clash
                    logger.info(`远程模式未指定客户端，默认使用 '${finalTargetClient}'。`);
                }
                logger.info(`动作: 为目标客户端 '${finalTargetClient}' 调用 subconverter。`);
                const backend = await c.env.DB.prepare("SELECT url FROM subconverter_assets WHERE id = ?").bind(content.subconverter_backend_id).first();
                const config = await c.env.DB.prepare("SELECT url FROM subconverter_assets WHERE id = ?").bind(content.subconverter_config_id).first();

                if (!backend || !config) {
                    logger.error('无法找到 Subconverter 后端或配置文件。');
                    return { type: 'text', payload: 'Subconverter 后端或配置文件未找到。', status: 500 };
                }

                const targetUrl = new URL((backend as any).url + '/sub');
                targetUrl.searchParams.set('target', finalTargetClient);
                targetUrl.searchParams.set('url', subconverterUrlInput);
                targetUrl.searchParams.set('config', (config as any).url);
                targetUrl.searchParams.set('filename', profile.name);
                
                logger.info('正在调用 subconverter...', { '请求URL': targetUrl.toString() });

                const subResponse = await fetch(targetUrl.toString(), { headers: { 'User-Agent': userAgent } });
                
                logger.info(`Subconverter 响应状态: ${subResponse.status}`);

                if (!subResponse.ok) {
                    const errorText = await subResponse.text();
                    logger.error('Subconverter 请求失败。', { '错误信息': errorText });
                    return { type: 'text', payload: `从 subconverter 生成失败: ${errorText}`, status: 502 };
                }
                logger.success('正在将 subconverter 的响应流式传输到客户端。');
                return { type: 'stream', payload: subResponse };
            }

            if (!subconverterUrlInput && !localContent) {
                logger.warn('没有生成任何内容，返回 404。');
                return { type: 'text', payload: '没有为指定的客户端生成任何内容。', status: 404 };
            }
            
            logger.warn('回退：没有特定的客户端目标或内容，返回 404。');
            return { type: 'text', payload: '没有为指定的客户端生成任何内容。', status: 404 };
        };

        result = await mainLogic();

    } catch (e: any) {
        logger.error(`处理配置文件 '${profile.name}' 时发生致命错误`, { '错误信息': e.message, '堆栈': e.stack });
        result = { type: 'text', payload: `内部服务器错误: ${e.message}`, status: 500 };
    } finally {
        logger.print();
    }

    // 最终响应处理
    if (!result) {
        return c.text('未知错误导致没有响应生成。', 500);
    }

    // 对于预览模式，总是附加日志
    if (isDryRun && result.type === 'json' && result.payload && result.payload.data) {
        result.payload.data.logs = logger.getLogs();
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