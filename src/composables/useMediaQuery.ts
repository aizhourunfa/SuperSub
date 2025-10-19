import { useMediaQuery as useVueUseMediaQuery } from '@vueuse/core';

/**
 * A composable to check for media queries.
 * This is a simple wrapper around VueUse's useMediaQuery.
 * We centralize it here in case we want to add custom logic or breakpoints later.
 *
 * @param query The media query string (e.g., '(max-width: 768px)')
 */
export function useMediaQuery(query: string) {
  return useVueUseMediaQuery(query);
}

// Pre-defined breakpoints for convenience
export const useIsMobile = () => useMediaQuery('(max-width: 768px)');
export const useIsTablet = () => useMediaQuery('(min-width: 769px) and (max-width: 1024px)');
export const useIsDesktop = () => useMediaQuery('(min-width: 1025px)');