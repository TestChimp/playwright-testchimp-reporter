export interface PageUrlParts {
  pagePath?: string;
  pageQuery?: string;
}

/** Must match featureservice BugPageUrlLimits / bugs table column lengths. */
export const BUG_PAGE_PATH_MAX_LENGTH = 2048;
export const BUG_PAGE_QUERY_MAX_LENGTH = 4096;

function truncatePageField(value: string | undefined, maxLength: number): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}

function clampPageUrlParts(parts: PageUrlParts): PageUrlParts {
  const pagePath = truncatePageField(parts.pagePath, BUG_PAGE_PATH_MAX_LENGTH);
  const pageQuery = truncatePageField(parts.pageQuery, BUG_PAGE_QUERY_MAX_LENGTH);
  return {
    ...(pagePath ? { pagePath } : {}),
    ...(pageQuery ? { pageQuery } : {}),
  };
}

/** Split full or relative URL into pathname and query (no domain, no hash). */
export function splitPageUrl(url: string): PageUrlParts {
  const trimmed = (url ?? '').trim();
  if (!trimmed || trimmed === 'about:blank' || trimmed.startsWith('about:')) {
    return {};
  }

  const withoutHash = trimmed.split('#')[0];

  try {
    const urlObj = new URL(withoutHash);
    const pagePath =
      urlObj.pathname && urlObj.pathname.length > 0
        ? urlObj.pathname
        : urlObj.host
          ? '/'
          : undefined;
    const pageQuery = urlObj.search ? urlObj.search.slice(1) : undefined;
    return clampPageUrlParts({
      ...(pagePath ? { pagePath } : {}),
      ...(pageQuery ? { pageQuery } : {}),
    });
  } catch {
    if (withoutHash.startsWith('/')) {
      const qIdx = withoutHash.indexOf('?');
      if (qIdx >= 0) {
        const pagePath = withoutHash.slice(0, qIdx) || undefined;
        const pageQuery = withoutHash.slice(qIdx + 1) || undefined;
        return clampPageUrlParts({ pagePath, pageQuery });
      }
      return clampPageUrlParts({ pagePath: withoutHash });
    }
    return {};
  }
}

type UrlCapable = { url?: () => string };

export function resolvePageUrlParts(target: unknown): PageUrlParts {
  const t = target as UrlCapable;
  if (typeof t?.url !== 'function') {
    return {};
  }
  try {
    return splitPageUrl(t.url());
  } catch {
    return {};
  }
}
