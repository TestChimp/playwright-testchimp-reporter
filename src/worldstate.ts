import * as fs from 'fs';
import * as path from 'path';

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
    if (entry.isFile() && entry.name.endsWith('.world.js')) {
      files.push(absPath);
    }
  }

  return files;
}

function ensureRegistryLoaded(): void {
  if (registryInitialized) return;
  registryInitialized = true;

  const cwd = process.cwd();
  const files = scanForWorldStateFiles(cwd);

  for (const absPath of files) {
    const relativePath = path.relative(cwd, absPath);
    const mod = require(absPath);
    const state = (mod.default || mod) as unknown;
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
}

function getWorldStateById(id: string): WorldStateDefinition {
  ensureRegistryLoaded();

  const entry = registry.get(id);
  if (!entry) {
    throw new Error(`WorldState not found: ${id}`);
  }

  if (!entry.loaded) {
    const absPath = path.resolve(process.cwd(), entry.relativePath);
    const mod = require(absPath);
    const state = (mod.default || mod) as unknown;
    validateWorldState(state, entry.relativePath);
    entry.loaded = state;
  }

  return entry.loaded;
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
  const state = getWorldStateById(id) as WorldStateDefinition<TContext>;
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
