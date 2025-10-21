import { useAuthStore } from '@/stores/auth';
import { LogoutInProgressError } from '@/utils/errors';

const BASE_URL = '/api';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
}

export const useApi = () => {
  const authStore = useAuthStore();

  const request = async <T>(endpoint: string, options: RequestInit & { timeout?: number } = {}): Promise<ApiResponse<T>> => {
    if (authStore.isLoggingOut) {
      throw new LogoutInProgressError(`Request to ${endpoint} cancelled due to logout.`);
    }
    const headers = new Headers(options.headers || {});
    if (authStore.token) {
      headers.set('Authorization', `Bearer ${authStore.token}`);
    }
    if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    const controller = new AbortController();
    const { timeout, ...restOptions } = options;
    const signal = controller.signal;

    const config: RequestInit = {
      ...restOptions,
      headers,
      signal,
    };

    let timeoutId: number | undefined;
    if (timeout) {
      timeoutId = window.setTimeout(() => controller.abort(), timeout);
    }

    try {
      const response = await fetch(`${BASE_URL}${endpoint}`, config);

      if (timeout) {
        clearTimeout(timeoutId);
      }

      if (response.status === 401) {
        authStore.logout();
        throw new Error('Session expired. Please log in again.');
      }

      if (response.status === 204) {
        return { success: true, data: {} as T }; // Return success with empty data
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const responseData: ApiResponse<T> = await response.json();
        if (!response.ok || (responseData.success === false)) {
          const errorMsg = responseData.message || `Request failed with status ${response.status}`;
          throw new Error(errorMsg);
        }
        return responseData;
      }

      // Handle non-JSON responses
      if (!response.ok) {
        const errorMsg = await response.text() || `Request failed with status ${response.status}`;
        throw new Error(errorMsg);
      }
      
      // For text/plain or other non-json successful responses
      return { success: true, data: await response.text() as any };

    } catch (error: any) {
      console.error(`API call to ${endpoint} failed:`, error);
      if (error.name === 'AbortError') {
        throw new Error('Request timed out.');
      }
      throw error;
    }
  };

  return {
    get: <T>(endpoint: string, options?: RequestInit) => request<T>(endpoint, { ...options, method: 'GET' }),
    post: <T>(endpoint: string, body: any, options?: RequestInit & { timeout?: number }) => request<T>(endpoint, { ...options, method: 'POST', body: JSON.stringify(body) }),
    put: <T>(endpoint: string, body: any, options?: RequestInit & { timeout?: number }) => request<T>(endpoint, { ...options, method: 'PUT', body: JSON.stringify(body) }),
    delete: <T>(endpoint: string, options?: RequestInit & { timeout?: number }) => request<T>(endpoint, { ...options, method: 'DELETE' }),
    patch: <T>(endpoint: string, body: any, options?: RequestInit & { timeout?: number }) => request<T>(endpoint, { ...options, method: 'PATCH', body: JSON.stringify(body) }),
    getBaseUrl: () => BASE_URL,
  };
};