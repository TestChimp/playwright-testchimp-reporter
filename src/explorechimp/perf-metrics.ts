/**
 * Browser performance metrics for ExploreChimp local runs — mirrors scriptservice
 * `helpers/watcher.ts` (PerformanceObserver pipeline + getMetricsSince / resetMetrics).
 */

import type { Page } from '@playwright/test';

export function parseExploreChimpLongTaskThresholdMs(): number {
  const raw = process.env.EXPLORECHIMP_LONG_TASK_THRESHOLD_MS?.trim();
  if (!raw) return 50;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

/**
 * Injects observers on every new document (Playwright init script). Idempotent per document.
 */
export async function installExploreChimpPerfMetricsObservers(
  page: Page,
  longTaskThresholdMs: number
): Promise<void> {
  await page.addInitScript(
    ({ longTaskThresholdMs: threshold }) => {
      const g = globalThis as unknown as {
        __longTaskThreshold?: number;
        __exploreChimpPerfInstalled?: boolean;
        __perfMetrics?: { entries: PerfEntry[]; cls: number; startTime: number };
        __interactionMetrics?: InteractionRecord[];
        __resourceTimings?: ResourceRecord[];
        __layoutShiftEntries?: LayoutShiftRecord[];
        performance: Performance;
      };
      g.__longTaskThreshold = threshold;
      if (g.__exploreChimpPerfInstalled) return;
      g.__exploreChimpPerfInstalled = true;

      type PerfEntry = {
        type: string;
        value: number;
        timestamp: number;
        cumulative?: number;
        name?: string;
        startTime?: number;
        attributionName?: string;
        attributionType?: string;
        containerType?: string;
        containerSrc?: string;
        containerId?: string;
      };

      type InteractionRecord = {
        duration: number;
        inputDelay?: number;
        processingDuration?: number;
        presentationDelay?: number;
        eventType: string;
        timestamp: number;
        targetElementId?: string;
        targetLocator?: string;
        boundingBox?: {
          xPct: number;
          yPct: number;
          widthPct: number;
          heightPct: number;
        };
      };

      type ResourceRecord = {
        url: string;
        initiatorType: string;
        duration: number;
        dnsLookupMs?: number;
        tcpConnectionMs?: number;
        tlsNegotiationMs?: number;
        requestTimeMs?: number;
        responseTimeMs?: number;
        transferSizeBytes?: number;
        encodedSizeBytes?: number;
        decodedSizeBytes?: number;
        fromCache?: boolean;
        timestamp: number;
        resourceType?: string;
      };

      type LayoutShiftRecord = {
        value: number;
        cumulative: number;
        timestamp: number;
        sources: unknown[];
      };

      g.__perfMetrics = g.__perfMetrics || { entries: [], cls: 0, startTime: Date.now() };
      g.__layoutShiftEntries = g.__layoutShiftEntries || [];

      function observeLcp(): void {
        try {
          const lcpObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const e = entry as { renderTime?: number; loadTime?: number };
              g.__perfMetrics!.entries.push({
                type: 'lcp',
                value: e.renderTime || e.loadTime || 0,
                timestamp: Date.now(),
              });
            }
          });
          lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {
          /* LCP not supported */
        }
      }

      function observeFcp(): void {
        try {
          const paintObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const pe = entry as { name?: string; startTime?: number };
              if (pe.name === 'first-contentful-paint') {
                g.__perfMetrics!.entries.push({
                  type: 'fcp',
                  value: pe.startTime || 0,
                  timestamp: Date.now(),
                });
              }
            }
          });
          paintObserver.observe({ type: 'paint', buffered: true });
        } catch {
          /* paint not supported */
        }
      }

      function observeCls(): void {
        try {
          const clsObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const le = entry as {
                hadRecentInput?: boolean;
                value?: number;
                sources?: unknown[];
              };
              if (!le.hadRecentInput) {
                g.__perfMetrics!.cls += le.value || 0;
                g.__perfMetrics!.entries.push({
                  type: 'cls',
                  value: le.value || 0,
                  cumulative: g.__perfMetrics!.cls,
                  timestamp: Date.now(),
                });
                const sources = (le.sources || []).map((source: unknown) => {
                  const s = source as {
                    node?: Element & {
                      tagName?: string;
                      id?: string;
                      className?: string;
                      textContent?: string | null;
                      getAttribute?: (n: string) => string | null;
                    };
                    currentRect?: DOMRectReadOnly;
                    previousRect?: DOMRectReadOnly;
                  };
                  const node = s.node;
                  const currentRect = s.currentRect;
                  let element: Record<string, unknown> | undefined;
                  if (node && currentRect) {
                    const tag = node.tagName?.toLowerCase();
                    const role = node.getAttribute?.('role') || undefined;
                    const id = node.id || undefined;
                    const syntheticId = node.getAttribute?.('data-synthetic-id') || undefined;
                    const ariaLabel = node.getAttribute?.('aria-label') || undefined;
                    let text: string | undefined;
                    try {
                      const tc = node.textContent || '';
                      if (tc.trim()) text = tc.trim().substring(0, 100);
                    } catch {
                      /* ignore */
                    }
                    let className: string | undefined;
                    try {
                      const ca = node.getAttribute?.('class') || String(node.className || '');
                      if (ca) className = ca.substring(0, 100);
                    } catch {
                      /* ignore */
                    }
                    element = { tag, role, text, id, className, syntheticId, ariaLabel };
                  }
                  const viewportWidth = window.innerWidth || 1;
                  const viewportHeight = window.innerHeight || 1;
                  const cr = currentRect || ({ left: 0, top: 0, width: 0, height: 0 } as DOMRectReadOnly);
                  const boundingBox = {
                    xPct: (cr.left / viewportWidth) * 100,
                    yPct: (cr.top / viewportHeight) * 100,
                    widthPct: (cr.width / viewportWidth) * 100,
                    heightPct: (cr.height / viewportHeight) * 100,
                  };
                  return { element, boundingBox };
                });
                (g.__layoutShiftEntries as LayoutShiftRecord[]).push({
                  value: le.value || 0,
                  cumulative: g.__perfMetrics!.cls,
                  timestamp: Date.now(),
                  sources,
                });
              }
            }
          });
          clsObserver.observe({ type: 'layout-shift', buffered: true });
        } catch {
          /* CLS not supported */
        }
      }

      function observeLongTasks(): void {
        try {
          const longTaskObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const lt = entry as {
                duration: number;
                name?: string;
                startTime?: number;
                attribution?: Array<{
                  name?: string;
                  entryType?: string;
                  containerType?: string;
                  containerSrc?: string;
                  containerId?: string;
                }>;
              };
              const duration = lt.duration;
              const th = g.__longTaskThreshold || 50;
              if (duration <= th) continue;
              let bestAttribution = lt.attribution?.[0];
              let scriptUrl = '';
              if (lt.attribution && lt.attribution.length > 0) {
                for (const attr of lt.attribution) {
                  if (attr.containerSrc && attr.containerSrc.trim() !== '') {
                    bestAttribution = attr;
                    scriptUrl = attr.containerSrc;
                    break;
                  }
                }
                if (!scriptUrl) {
                  for (const attr of lt.attribution) {
                    if (attr.containerType && attr.containerType !== 'unknown') {
                      bestAttribution = attr;
                      break;
                    }
                  }
                }
              }
              const attributionName = bestAttribution?.name || lt.name || 'unknown';
              const attributionType = bestAttribution?.entryType || (lt.name ? 'longtask' : 'unknown');
              g.__perfMetrics!.entries.push({
                type: 'longtask',
                value: duration,
                timestamp: Date.now(),
                name: lt.name || 'unknown',
                startTime: lt.startTime || 0,
                attributionName,
                attributionType,
                containerType:
                  bestAttribution?.containerType || (lt.name === 'self' ? 'window' : 'unknown'),
                containerSrc: scriptUrl || bestAttribution?.containerSrc || '',
                containerId: bestAttribution?.containerId || '',
              });
            }
          });
          longTaskObserver.observe({ type: 'longtask', buffered: true });
        } catch {
          /* longtask not supported */
        }
      }

      function determineResourceType(initiatorType: string, url: string): string {
        if (initiatorType === 'script' || url.endsWith('.js')) return 'script';
        if (initiatorType === 'link' || url.endsWith('.css')) return 'stylesheet';
        if (initiatorType === 'img' || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(url)) return 'image';
        if (/\.(woff|woff2|ttf|otf|eot)$/i.test(url)) return 'font';
        if (initiatorType === 'xmlhttprequest' || initiatorType === 'fetch') return 'fetch';
        return 'other';
      }

      function buildLocatorFromElement(element: HTMLElement): string {
        const testId = element.getAttribute('data-testid');
        if (testId) return `getByTestId('${testId}')`;
        const id = element.id;
        if (id) return `#${id}`;
        const ariaLabel = element.getAttribute('aria-label');
        if (ariaLabel) return `getByLabel('${ariaLabel}')`;
        const role = element.getAttribute('role') || element.tagName.toLowerCase();
        const name = ariaLabel || element.textContent?.trim() || '';
        if (name) return `getByRole('${role}', { name: '${name.substring(0, 50)}' })`;
        const tag = element.tagName.toLowerCase();
        const text = element.textContent?.trim();
        if (text) return `getByText('${text.substring(0, 50)}')`;
        return element.tagName.toLowerCase() + (element.className ? `.${String(element.className).split(' ')[0]}` : '');
      }

      function observeEventTiming(): void {
        try {
          g.__interactionMetrics = g.__interactionMetrics || [];
          const PerfEvtCtor =
            typeof PerformanceEventTiming !== 'undefined' ? PerformanceEventTiming : undefined;
          const eventTimingObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.entryType !== 'event') continue;
              if (PerfEvtCtor && !(entry instanceof PerfEvtCtor)) continue;
              const eventEntry = entry as PerformanceEventTiming;
              const eventName = eventEntry.name;
              if (eventName !== 'click' && eventName !== 'dblclick' && eventName !== 'change') continue;
              const target = eventEntry.target as HTMLElement | undefined;
              if (!target) continue;
              if (eventName === 'change') {
                const tagName = target.tagName;
                const inputType = (target as HTMLInputElement).type;
                const isSelect = tagName === 'SELECT';
                const isCheckbox = tagName === 'INPUT' && inputType === 'checkbox';
                const isRadio = tagName === 'INPUT' && inputType === 'radio';
                if (!isSelect && !isCheckbox && !isRadio) continue;
              }
              const somId = target.getAttribute('tc-som-id');
              const syntheticId = target.getAttribute('data-synthetic-id');
              const elementId = somId ?? syntheticId ?? undefined;
              const rect = target.getBoundingClientRect();
              const viewportWidth = window.innerWidth;
              const viewportHeight = window.innerHeight;
              const boundingBox = {
                xPct: (rect.left / viewportWidth) * 100,
                yPct: (rect.top / viewportHeight) * 100,
                widthPct: (rect.width / viewportWidth) * 100,
                heightPct: (rect.height / viewportHeight) * 100,
              };
              const locator = buildLocatorFromElement(target);
              const inputDelay = eventEntry.processingStart - eventEntry.startTime;
              const processingDuration = eventEntry.processingEnd - eventEntry.processingStart;
              const presentationDelay = eventEntry.duration - (eventEntry.processingEnd - eventEntry.startTime);
              if (!g.__interactionMetrics) g.__interactionMetrics = [];
              const MAX_INTERACTION_METRICS = 200;
              if (g.__interactionMetrics.length >= MAX_INTERACTION_METRICS) g.__interactionMetrics.shift();
              g.__interactionMetrics.push({
                duration: eventEntry.duration,
                inputDelay,
                processingDuration,
                presentationDelay,
                eventType: eventEntry.name,
                timestamp: Date.now(),
                targetElementId: elementId,
                targetLocator: locator,
                boundingBox,
              });
            }
          });
          const eventObserverOptions: PerformanceObserverInit = { type: 'event', buffered: true };
          (eventObserverOptions as { durationThreshold?: number }).durationThreshold = 80;
          eventTimingObserver.observe(eventObserverOptions);
        } catch {
          /* Event Timing not supported */
        }
      }

      function observeResourceTiming(): void {
        try {
          if (g.performance.setResourceTimingBufferSize) {
            g.performance.setResourceTimingBufferSize(500);
          }
          g.__resourceTimings = g.__resourceTimings || [];
          const resourceTimingObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.entryType !== 'resource') continue;
              const resourceEntry = entry as PerformanceResourceTiming;
              const dnsLookup = Math.max(0, resourceEntry.domainLookupEnd - resourceEntry.domainLookupStart);
              const tcpConnection = Math.max(0, resourceEntry.connectEnd - resourceEntry.connectStart);
              const tlsNegotiation =
                resourceEntry.secureConnectionStart > 0
                  ? Math.max(0, resourceEntry.connectEnd - resourceEntry.secureConnectionStart)
                  : 0;
              const requestTime = Math.max(0, resourceEntry.responseStart - resourceEntry.requestStart);
              const responseTime = Math.max(0, resourceEntry.responseEnd - resourceEntry.responseStart);
              const duration = Math.max(0, resourceEntry.responseEnd - resourceEntry.fetchStart);
              const initiatorType = resourceEntry.initiatorType || 'other';
              const resourceType = determineResourceType(initiatorType, resourceEntry.name);
              if (!g.__resourceTimings) g.__resourceTimings = [];
              const MAX_RESOURCE_TIMINGS = 200;
              if (g.__resourceTimings.length >= MAX_RESOURCE_TIMINGS) g.__resourceTimings.shift();
              g.__resourceTimings.push({
                url: resourceEntry.name,
                initiatorType,
                duration,
                dnsLookupMs: dnsLookup > 0 ? dnsLookup : undefined,
                tcpConnectionMs: tcpConnection > 0 ? tcpConnection : undefined,
                tlsNegotiationMs: tlsNegotiation > 0 ? tlsNegotiation : undefined,
                requestTimeMs: requestTime > 0 ? requestTime : undefined,
                responseTimeMs: responseTime > 0 ? responseTime : undefined,
                transferSizeBytes: resourceEntry.transferSize > 0 ? resourceEntry.transferSize : undefined,
                encodedSizeBytes: resourceEntry.encodedBodySize > 0 ? resourceEntry.encodedBodySize : undefined,
                decodedSizeBytes: resourceEntry.decodedBodySize > 0 ? resourceEntry.decodedBodySize : undefined,
                fromCache: resourceEntry.transferSize === 0 && resourceEntry.decodedBodySize > 0,
                timestamp: Date.now(),
                resourceType,
              });
            }
          });
          resourceTimingObserver.observe({ type: 'resource', buffered: true });
        } catch {
          /* resource timing not supported */
        }
      }

      observeLcp();
      observeFcp();
      observeCls();
      observeLongTasks();
      observeEventTiming();
      observeResourceTiming();
    },
    { longTaskThresholdMs }
  );
}

/** Same semantics as watcher.getMetricsSince — filters perf entries by wall-clock `since`. */
export async function collectMetricsSince(
  page: Page,
  sinceTimestamp: number
): Promise<Record<string, unknown> | null> {
  return page.evaluate((since) => {
    const w = globalThis as unknown as {
      __perfMetrics?: {
        entries: Array<{
          type: string;
          value: number;
          timestamp: number;
          cumulative?: number;
          name?: string;
          startTime?: number;
          attributionName?: string;
          attributionType?: string;
          containerType?: string;
          containerSrc?: string;
          containerId?: string;
        }>;
        cls: number;
      };
      __interactionMetrics?: Array<Record<string, unknown>>;
      __resourceTimings?: Array<Record<string, unknown>>;
      __layoutShiftEntries?: Array<Record<string, unknown>>;
    };

    function fallbackFromPerformanceTimeline(): Record<string, unknown> {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const paint = performance.getEntriesByType('paint') as PerformancePaintTiming[];
      const fcp = paint.find((p) => p.name === 'first-contentful-paint')?.startTime ?? 0;
      const lcpEntries = performance.getEntriesByType('largest-contentful-paint') as PerformanceEntry[];
      const lastLcp = lcpEntries.length > 0 ? lcpEntries[lcpEntries.length - 1] : null;
      const lcpMs = lastLcp
        ? ((lastLcp as unknown as { renderTime?: number; loadTime?: number }).renderTime ??
            (lastLcp as unknown as { renderTime?: number; loadTime?: number }).loadTime ??
            0)
        : 0;
      let cls = 0;
      try {
        const shifts = performance.getEntriesByType('layout-shift') as Array<{
          value?: number;
          hadRecentInput?: boolean;
        }>;
        for (const s of shifts) {
          if (!s.hadRecentInput) cls += s.value ?? 0;
        }
      } catch {
        /* ignore */
      }
      const mem = (performance as { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } }).memory;
      return {
        lcp: lcpMs,
        fcp,
        cls,
        collectedAt: String(Date.now()),
        longTasksCount: 0,
        longTasksTotalMs: 0,
        memoryHeapUsedMb: mem?.usedJSHeapSize ? mem.usedJSHeapSize / (1024 * 1024) : undefined,
        memoryHeapTotalMb: mem?.totalJSHeapSize ? mem.totalJSHeapSize / (1024 * 1024) : undefined,
        tbt: nav ? Math.max(0, (nav.loadEventEnd - nav.fetchStart) * 0.01) : 0,
      };
    }

    if (!w.__perfMetrics) {
      return fallbackFromPerformanceTimeline();
    }

    const allEntries = w.__perfMetrics.entries || [];
    const entries = allEntries.filter((e) => e.timestamp >= since);

    const lcpEntries = entries.filter((e) => e.type === 'lcp');
    const lcp = lcpEntries.length > 0 ? lcpEntries[lcpEntries.length - 1].value : undefined;

    const fcpEntries = entries.filter((e) => e.type === 'fcp');
    const fcp = fcpEntries.length > 0 ? fcpEntries[0].value : undefined;

    const cls = w.__perfMetrics.cls;

    const longTasks = entries.filter((e) => e.type === 'longtask');
    const longTasksCount = longTasks.length;
    const longTasksTotalMs = longTasks.reduce((sum, task) => sum + task.value, 0);
    const tbt = longTasks.reduce((sum, task) => sum + Math.max(0, task.value - 50), 0);

    const longTaskDetails = longTasks.map((task) => ({
      name: task.name || 'unknown',
      startTime: task.startTime || 0,
      duration: task.value,
      attributionName: task.attributionName || 'unknown',
      attributionType: task.attributionType || 'unknown',
      containerType: task.containerType || 'unknown',
      containerSrc: task.containerSrc || '',
      containerId: task.containerId || '',
    }));

    let memoryHeapUsedMb: number | undefined;
    let memoryHeapTotalMb: number | undefined;
    const perfMem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } })
      .memory;
    if (perfMem) {
      memoryHeapUsedMb = perfMem.usedJSHeapSize / (1024 * 1024);
      memoryHeapTotalMb = perfMem.totalJSHeapSize / (1024 * 1024);
    }

    let interactionLatencies: Array<Record<string, unknown>> | undefined;
    if (w.__interactionMetrics && w.__interactionMetrics.length > 0) {
      const filtered = w.__interactionMetrics.filter(
        (entry) => (entry.timestamp as number) >= since
      ) as Array<Record<string, unknown>>;
      if (filtered.length > 0) interactionLatencies = filtered;
    }

    let resourceTimings: Array<Record<string, unknown>> | undefined;
    if (w.__resourceTimings && w.__resourceTimings.length > 0) {
      const filtered = w.__resourceTimings.filter(
        (entry) => (entry.timestamp as number) >= since
      ) as Array<Record<string, unknown>>;
      if (filtered.length > 0) resourceTimings = filtered;
    }

    let layoutShiftEntries: Array<Record<string, unknown>> | undefined;
    if (w.__layoutShiftEntries && w.__layoutShiftEntries.length > 0) {
      const filtered = w.__layoutShiftEntries.filter((entry) => (entry.timestamp as number) >= since);
      w.__layoutShiftEntries = w.__layoutShiftEntries.filter((entry) => (entry.timestamp as number) < since);
      if (filtered.length > 0) layoutShiftEntries = filtered;
    }

    const base: Record<string, unknown> = {
      lcp,
      fcp,
      cls,
      tbt,
      longTasksCount,
      longTasksTotalMs,
      longTaskDetails,
      memoryHeapUsedMb,
      memoryHeapTotalMb,
      collectedAt: Date.now(),
    };
    if (interactionLatencies) base.interactionLatencies = interactionLatencies;
    if (resourceTimings) base.resourceTimings = resourceTimings;
    if (layoutShiftEntries) base.layoutShiftEntries = layoutShiftEntries;

    const hasAny =
      lcp !== undefined ||
      fcp !== undefined ||
      cls !== undefined ||
      tbt > 0 ||
      longTasksCount > 0 ||
      (interactionLatencies && interactionLatencies.length > 0) ||
      (resourceTimings && resourceTimings.length > 0);
    if (!hasAny) {
      return fallbackFromPerformanceTimeline();
    }
    return base;
  }, sinceTimestamp);
}

/** Clears in-page metric buffers (watcher.resetMetrics). */
export async function resetExploreChimpPerfMetricsBuffers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __perfMetrics?: { entries: unknown[]; cls: number; startTime: number };
      __interactionMetrics?: unknown[];
      __resourceTimings?: unknown[];
      __layoutShiftEntries?: unknown[];
    };
    if (w.__perfMetrics) {
      w.__perfMetrics.entries = [];
      w.__perfMetrics.cls = 0;
      w.__perfMetrics.startTime = Date.now();
    }
    if (w.__interactionMetrics) w.__interactionMetrics = [];
    if (w.__resourceTimings) w.__resourceTimings = [];
    if (w.__layoutShiftEntries) w.__layoutShiftEntries = [];
  });
}
