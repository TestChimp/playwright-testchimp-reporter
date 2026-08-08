import type { TestCase, TestResult } from '@playwright/test/reporter';
import type { TestAnnotation } from './types';

type AnnotationLike = { type?: string; description?: string };

/**
 * Merge TestCase + TestResult annotations, deduped by (type, description).
 */
export function collectPlaywrightAnnotations(
  test: TestCase,
  result?: TestResult | null
): TestAnnotation[] {
  const seen = new Set<string>();
  const out: TestAnnotation[] = [];
  const pushAll = (list: readonly AnnotationLike[] | undefined) => {
    if (!list) {
      return;
    }
    for (const a of list) {
      const type = typeof a?.type === 'string' ? a.type : '';
      if (!type) {
        continue;
      }
      const description = typeof a?.description === 'string' ? a.description : '';
      const key = `${type}\0${description}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ type, description });
    }
  };
  pushAll(test.annotations as AnnotationLike[] | undefined);
  pushAll(result?.annotations as AnnotationLike[] | undefined);
  return out;
}
