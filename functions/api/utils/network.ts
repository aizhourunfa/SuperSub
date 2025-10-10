import { userAgents } from './constants';

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

export const fetchSubscriptionContent = async (url: string, timeoutSeconds: number = 10): Promise<string | null> => {
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
                return content;
            } else {
                return null;
            }
        } else {
            return null;
        }
    } catch (e: any) {
        clearTimeout(timeoutId);
        console.error(`获取订阅 ${url} 时出错: ${e.message}`);
        return null;
    }
};