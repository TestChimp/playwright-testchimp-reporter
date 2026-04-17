import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

export interface WorldStateDefinition<TContext extends Record<string, unknown> = Record<string, unknown>> {
  meta: {
    id: string;
    description: string;
  };
  setup: (ctx: TContext) => Promise<void> | void;
  teardown?: (ctx: TContext) => Promise<void> | void;
}

interface WorldStateRegistryEntry {
  id: string;
  relativePath: string;
  loaded?: WorldStateDefinition;
}

const registry = new Map<string, WorldStateRegistryEntry>();
let registryInitialized = false;
let registryInitPromise: Promise<void> | null = null;

// Preserve native dynamic import in CommonJS output (tsc would otherwise transform to require()).
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<{ default?: unknown } & Record<string, unknown>>;

async function loadWorldStateModule(absPath: string): Promise<unknown> {
  try {
    // Fast path for CommonJS world-states.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(absPath);
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    const isEsm =
      e?.code === 'ERR_REQUIRE_ESM' ||
      (typeof e?.message === 'string' && e.message.includes('require() of ES Module'));
    if (!isEsm) throw err;

    // ESM world-states: load via dynamic import.
    const mod = await dynamicImport(pathToFileURL(absPath).href);
    return mod;
  }
}

function validateWorldState(def: unknown, sourcePath: string): asserts def is WorldStateDefinition {
  if (!def || typeof def !== 'object') {
    throw new Error(`WorldState in ${sourcePath} must be an object`);
  }
  const ws = def as Partial<WorldStateDefinition>;
  if (!ws.meta || typeof ws.meta !== 'object') {
    throw new Error(`WorldState in ${sourcePath} must have meta`);
  }
  if (!ws.meta.id) {
    throw new Error(`WorldState in ${sourcePath} must have meta.id`);
  }
  if (!ws.meta.description) {
    throw new Error(`WorldState in ${sourcePath} must have meta.description`);
  }
  if (typeof ws.setup !== 'function') {
    throw new Error(`WorldState in ${sourcePath} must define setup(ctx)`);
  }
  if (ws.teardown && typeof ws.teardown !== 'function') {
    throw new Error(`WorldState in ${sourcePath} teardown must be a function when provided`);
  }
}

function scanForWorldStateFiles(baseDir: string): string[] {
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanForWorldStateFiles(absPath));
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name.endsWith('.world.js') ||
        entry.name.endsWith('.world.mjs') ||
        entry.name.endsWith('.world.cjs'))
    ) {
      files.push(absPath);
    }
  }

  return files;
}

async function ensureRegistryLoaded(): Promise<void> {
  if (registryInitialized) return;
  if (registryInitPromise) return registryInitPromise;

  registryInitPromise = (async () => {
    registryInitialized = true;

    const cwd = process.cwd();
    const files = scanForWorldStateFiles(cwd);

    for (const absPath of files) {
      const relativePath = path.relative(cwd, absPath);
      const mod = await loadWorldStateModule(absPath);
      const state = ((mod as { default?: unknown }).default || mod) as unknown;
      validateWorldState(state, relativePath);

      const id = state.meta.id;
      if (registry.has(id)) {
        const existing = registry.get(id)!;
        throw new Error(
          `Duplicate WorldState id "${id}" found in "${existing.relativePath}" and "${relativePath}"`,
        );
      }

      registry.set(id, {
        id,
        relativePath,
        loaded: state,
      });
    }
  })().finally(() => {
    registryInitPromise = null;
  });

  return registryInitPromise;
}

async function getWorldStateByIdAsync(id: string): Promise<WorldStateDefinition> {
  await ensureRegistryLoaded();

  const entry = registry.get(id);
  if (!entry) {
    throw new Error(`WorldState not found: ${id}`);
  }

  if (!entry.loaded) {
    const absPath = path.resolve(process.cwd(), entry.relativePath);
    const mod = await loadWorldStateModule(absPath);
    const state = ((mod as { default?: unknown }).default || mod) as unknown;
    validateWorldState(state, entry.relativePath);
    entry.loaded = state;
  }

  return entry.loaded;
}

/**
 * Synchronous accessor (backwards compatible).
 *
 * Note: This will only work for CommonJS world-states. If your world-state is ESM, use
 * {@link ensureWorldState} / {@link teardownWorldState} which support async loading.
 */
export function getWorldStateById(id: string): WorldStateDefinition {
  // Do not initialize via async loader here. Keep legacy behavior for callers that expect sync.
  if (!registryInitialized) {
    registryInitialized = true;
    const cwd = process.cwd();
    const files = scanForWorldStateFiles(cwd);
    for (const absPath of files) {
      const relativePath = path.relative(cwd, absPath);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(absPath);
      const state = ((mod as { default?: unknown }).default || mod) as unknown;
      validateWorldState(state, relativePath);
      const ws = state as WorldStateDefinition;
      const wsId = ws.meta.id;
      if (registry.has(wsId)) {
        const existing = registry.get(wsId)!;
        throw new Error(
          `Duplicate WorldState id "${wsId}" found in "${existing.relativePath}" and "${relativePath}"`,
        );
      }
      registry.set(wsId, { id: wsId, relativePath, loaded: ws });
    }
  }

  const entry = registry.get(id);
  if (!entry || !entry.loaded) {
    throw new Error(`WorldState not found: ${id}`);
  }
  return entry.loaded;
}

/**
 * Run teardown for a world-state using a fresh context object.
 * Use when you did not keep the {@link ensureWorldState} return value (e.g. simplified-view codegen).
 * World-states whose teardown depends on the exact same ctx instance setup mutated are not supported here.
 */
export async function teardownWorldState(
  id: string,
  ctx: Record<string, unknown> = {},
): Promise<void> {
  const state = await getWorldStateByIdAsync(id);
  if (state.teardown) {
    await state.teardown(ctx);
  }
}

/** @internal Reset registry between tests (Node test runner). */
export function __resetWorldStateRegistryForTests(): void {
  registry.clear();
  registryInitialized = false;
  registryInitPromise = null;
}

export function defineWorldState<TContext extends Record<string, unknown> = Record<string, unknown>>(
  def: WorldStateDefinition<TContext>,
): WorldStateDefinition<TContext> {
  validateWorldState(def, 'inline-definition');
  return def;
}

export async function ensureWorldState<TContext extends Record<string, unknown> = Record<string, unknown>>(
  id: string,
  ctx = {} as TContext,
): Promise<{ id: string; ctx: TContext; teardown: () => Promise<void> }> {
  const state = (await getWorldStateByIdAsync(id)) as WorldStateDefinition<TContext>;
  await state.setup(ctx);

  return {
    id,
    ctx,
    teardown: async () => {
      if (state.teardown) {
        await state.teardown(ctx);
      }
    },
  };
}
