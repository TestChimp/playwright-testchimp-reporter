/**
 * Bridges ExploreChimp analytics `test.step` rows to {@link SmartTestExecutionStep.screenState} without
 * parsing step titles. Keys match {@link stableExploreChimpAnalyticsStepId} / analyze `step_id`.
 */

const registry = new Map<string, { name: string; state: string }>();

export function registerExploreChimpAnalyticsStepScreenState(
  stepId: string,
  screenState: { name: string; state: string }
): void {
  if (!stepId) return;
  registry.set(stepId, { name: screenState.name, state: screenState.state });
}

export function consumeExploreChimpAnalyticsStepScreenState(
  stepId: string
): { name: string; state: string } | undefined {
  if (!stepId) return undefined;
  const v = registry.get(stepId);
  if (v === undefined) return undefined;
  registry.delete(stepId);
  return v;
}
