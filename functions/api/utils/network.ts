import { userAgents } from './constants';
import { Logger } from './logger';

export const fetchWithTimeout = (url: string, options: RequestInit, timeout: number): Promise<Response> => {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const { signal } = controller;
    options.signal = signal;

    const timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error('Request timed out'));
    }, timeout);

    fetch(url, options)
      .then(response => {
        clearTimeout(timeoutId);
        resolve(response);
      })
      .catch(error => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
};

export const fetchSubscriptionContent = async (url: string, logger: Logger, timeoutSeconds: number = 10): Promise<string | null> => {
    const controller = new AbortController();
    const timeoutMs = timeoutSeconds * 1000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)] },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
            const content = await response.text();
            if (content) {
                logger.success(`订阅内容获取成功。`, { url });
                return content;
            } else {
                logger.warn(`订阅内容为空。`, { url });
                return null;
            }
        } else {
            logger.error(`获取订阅失败: HTTP状态 ${response.status}`, { url, status: response.status });
            return null;
        }
    } catch (e: any) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
            logger.error(`订阅请求超时 (${timeoutSeconds} 秒)。`, { url });
        } else {
            logger.error(`处理订阅时发生网络错误: ${e.message}`, { url, error: e.message });
        }
        return null;
    }
};