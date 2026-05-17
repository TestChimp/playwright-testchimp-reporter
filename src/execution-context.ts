import type { Suite, TestCase } from '@playwright/test/reporter';
import {
  platformFromTestInfo,
  type RunPlatform,
  type TestInfoWithPlatformHints,
} from './project-type';

export enum ExecutionPlatform {
  UNKNOWN_EXECUTION_PLATFORM = 0,
  WEB_EXECUTION_PLATFORM = 1,
  IOS_EXECUTION_PLATFORM = 2,
  ANDROID_EXECUTION_PLATFORM = 3,
}

export enum ScreenOrientation {
  UNKNOWN_SCREEN_ORIENTATION = 0,
  PORTRAIT_SCREEN_ORIENTATION = 1,
  LANDSCAPE_SCREEN_ORIENTATION = 2,
}

export interface ExecutionDeviceContext {
  platform?: ExecutionPlatform;
  deviceFamily?: string;
  osVersion?: string;
  screenResolution?: string;
  screenOrientation?: ScreenOrientation;
}

function runPlatformToExecutionPlatform(p: RunPlatform): ExecutionPlatform {
  switch (p) {
    case 'ios':
      return ExecutionPlatform.IOS_EXECUTION_PLATFORM;
    case 'android':
      return ExecutionPlatform.ANDROID_EXECUTION_PLATFORM;
    default:
      return ExecutionPlatform.WEB_EXECUTION_PLATFORM;
  }
}

function annotationValue(hints: TestInfoWithPlatformHints, type: string): string | undefined {
  for (const a of hints.annotations ?? []) {
    if (a.type === type && a.description) {
      return a.description;
    }
  }
  return undefined;
}

function orientationFromViewport(width: number, height: number): ScreenOrientation {
  if (width > height) {
    return ScreenOrientation.LANDSCAPE_SCREEN_ORIENTATION;
  }
  if (width < height) {
    return ScreenOrientation.PORTRAIT_SCREEN_ORIENTATION;
  }
  return ScreenOrientation.UNKNOWN_SCREEN_ORIENTATION;
}

/** Resolve project + annotations from a reporter TestCase (no TestInfo in onTestEnd). */
export function platformHintsFromTestCase(test: TestCase): TestInfoWithPlatformHints {
  let suite: Suite | undefined = test.parent;
  while (suite) {
    const project = suite.project();
    if (project) {
      return { project, annotations: test.annotations };
    }
    suite = suite.parent;
  }
  return { annotations: test.annotations };
}

/**
 * Build execution device context from the Playwright/Mobilewright project that ran this test.
 * Accepts TestInfo (fixtures/runtime) or TestCase (reporter onTestEnd).
 */
export function buildExecutionDeviceContext(
  source: TestInfoWithPlatformHints | TestCase
): ExecutionDeviceContext {
  const hints = 'parent' in source ? platformHintsFromTestCase(source) : source;
  const runPlatform = platformFromTestInfo(hints);
  const platform = runPlatformToExecutionPlatform(runPlatform);
  const use = (hints.project?.use ?? {}) as Record<string, unknown>;

  let deviceFamily: string | undefined;
  let screenResolution: string | undefined;
  let screenOrientation: ScreenOrientation | undefined;
  let osVersion: string | undefined;

  if (runPlatform === 'web') {
    const channel = typeof use.channel === 'string' ? use.channel : undefined;
    const browserName = typeof use.browserName === 'string' ? use.browserName : undefined;
    deviceFamily = channel ?? browserName ?? hints.project?.name;
    const viewport = use.viewport as { width?: number; height?: number } | null | undefined;
    if (viewport && typeof viewport.width === 'number' && typeof viewport.height === 'number') {
      screenResolution = `${viewport.width}x${viewport.height}`;
      screenOrientation = orientationFromViewport(viewport.width, viewport.height);
    }
  } else {
    deviceFamily =
      annotationValue(hints, 'device.name') ??
      annotationValue(hints, 'device.model') ??
      (runPlatform === 'ios' ? 'iOS Device' : 'Android Device');
    osVersion = annotationValue(hints, 'device.os_version');
    const sw = annotationValue(hints, 'device.screen_width');
    const sh = annotationValue(hints, 'device.screen_height');
    if (sw && sh) {
      screenResolution = `${sw}x${sh}`;
    }
    const orient = annotationValue(hints, 'device.orientation');
    if (orient === 'landscape') {
      screenOrientation = ScreenOrientation.LANDSCAPE_SCREEN_ORIENTATION;
    } else if (orient === 'portrait') {
      screenOrientation = ScreenOrientation.PORTRAIT_SCREEN_ORIENTATION;
    }
  }

  return {
    platform,
    deviceFamily,
    osVersion,
    screenResolution,
    screenOrientation,
  };
}
