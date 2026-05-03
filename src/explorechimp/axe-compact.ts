/**
 * Shrinks axe-core analyze() output for ExploreChimp POST payloads.
 * scriptservice only consumes {@code violations} in {@code bugsFromAxeAnalyzeResultsJson}.
 * Goal: surface high-impact issues first — not exhaustive coverage.
 */

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}

const IMPACT_RANK: Record<string, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

function impactOrder(impact: string | undefined): number {
  if (!impact) return 99;
  return IMPACT_RANK[impact] ?? 50;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = raw != null ? Number.parseInt(String(raw).trim(), 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function compactAxeResultsForUpload(axeResults: unknown): string {
  const maxViolations = parsePositiveInt(process.env.EXPLORECHIMP_AXE_MAX_VIOLATIONS, 25);
  const maxNodes = parsePositiveInt(process.env.EXPLORECHIMP_AXE_MAX_NODES_PER_VIOLATION, 8);

  if (!axeResults || typeof axeResults !== 'object') {
    return JSON.stringify({ violations: [] });
  }

  const ar = axeResults as Record<string, unknown>;
  const violationsIn = Array.isArray(ar.violations) ? ([...ar.violations] as Record<string, unknown>[]) : [];
  violationsIn.sort(
    (a, b) => impactOrder(String(a.impact)) - impactOrder(String(b.impact))
  );

  const violations = violationsIn.slice(0, maxViolations).map((v) => {
    const nodesIn = Array.isArray(v.nodes) ? (v.nodes as Record<string, unknown>[]) : [];
    const nodes = nodesIn.slice(0, maxNodes).map((n) => ({
      target: n.target,
      html: truncate(String(n.html ?? ''), 500),
      failureSummary: n.failureSummary != null ? truncate(String(n.failureSummary), 400) : undefined,
    }));
    return {
      id: v.id,
      impact: v.impact,
      help: truncate(String(v.help ?? ''), 400),
      description: truncate(String(v.description ?? ''), 600),
      helpUrl: v.helpUrl,
      nodes,
    };
  });

  return JSON.stringify({ violations });
}
