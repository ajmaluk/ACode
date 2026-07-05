# Phase 15: Configuration System

> **Estimated Effort:** 3-4 days
> **Dependencies:** Phase 8 (security), Phase 12 (performance)
> **Priority:** Medium

## Current State

Configuration is scattered across localStorage with 46+ keys, hardcoded values in source files, and no validation or migration system. Settings are read synchronously at startup with no schema validation.

### Configuration Storage Map

| Key Pattern | Location | Purpose | Validation |
|-------------|----------|---------|------------|
| `dalam.settings.v1` | localStorage | App settings | DEFAULT_SETTINGS merge |
| `dalam.providers.v1` | localStorage | LLM providers | None |
| `dalam.provider.{id}` | localStorage | Per-provider config | None |
| `dalam.recentFiles.v1` | localStorage | Recent files | None |
| `dalam.mcpServers.v1` | localStorage | MCP servers | None |
| `dalam.skills.bundled.v1` | localStorage | Bundled skills | None |
| `dalam.skills.user.v1` | localStorage | User skills | None |
| `dalam.connectors.v1` | localStorage | Connector configs | None |
| `dalam.alwaysAllowed.v1` | localStorage | Permission rules | None |
| `dalam.session.{id}.messages` | localStorage | Session messages | None |
| `dalam.session.{id}.versions` | localStorage | Session versions | None |
| `dalam.session.{id}.agents` | localStorage | Agent states | None |
| `dalam.session.{sessionId}.summaries` | localStorage | Compaction summaries | None |
| `dalam.lastDreamTime.{path}` | localStorage | Dream timing | None |
| `dalam.workspaces.v1` | localStorage | Workspace list | None |
| `dalam.enabledSkills.v1` | localStorage | Enabled skills | None |
| `__GENE_POOL__` | localStorage | Gene pool | None |

**Total:** 17+ distinct key patterns, 46+ actual keys

### Hardcoded Values

| File | Line | Value | Issue |
|------|------|-------|-------|
| `contextManager.ts` | 86-87 | `0.60`, `0.75` | Proactive thresholds hardcoded |
| `contextManager.ts` | 44 | `1000` | Token cache max entries |
| `toolExecutor.ts` | 65-67 | `2`, `1000`, `2` | Retry config hardcoded |
| `memoryTypes.ts` | (constants) | Various | Memory thresholds |
| `agentRuntimeContract.ts` | 338 | `200` | transitionLog cap |
| `dalamAPI.ts` | 32 | `1` | Rate limit backoff |
| `dreamAgent.ts` | (timing) | `30 min` | Dream interval |
| `mcpCache.ts` | 62 | `3600` | Default TTL |
| `skillCrystallizer.ts` | (budget) | `50` | Skill budget |

### No Validation

- Settings are loaded with `{ ...DEFAULT_SETTINGS, ...JSON.parse(raw) }` — no schema check
- Provider configs have no baseUrl/apiKey validation
- MCP server configs have no command validation
- Connector configs have no schema validation
- No migration system for settings version upgrades

## Issues Found

### 1. No Schema Validation for Settings
**Severity:** HIGH
**Location:** `dalamAPI.ts:99-104`
**Issue:** Settings are loaded with a simple spread merge. Invalid values (wrong types, missing fields) silently use defaults.
**Fix:** Add Zod schema validation for all settings.

### 2. No Migration System
**Severity:** MEDIUM
**Location:** All `dalam.*.v1` keys
**Issue:** When settings schema changes between versions, old data is silently merged or discarded.
**Fix:** Add versioned migrations that transform old schemas to new.

### 3. Hardcoded Configuration Values
**Severity:** MEDIUM
**Location:** Multiple files
**Issue:** Critical thresholds (retry counts, cache sizes, timing intervals) are hardcoded and require code changes to modify.
**Fix:** Move all tunable values to settings with sensible defaults.

### 4. No Settings Export/Import
**Severity:** LOW
**Location:** SettingsModal.tsx
**Issue:** Users cannot export/import their configuration for backup or sharing.
**Fix:** Add export/import buttons in settings.

### 5. No Environment-Based Configuration
**Severity:** LOW
**Location:** Throughout
**Issue:** No way to override settings via environment variables for development/testing.
**Fix:** Add env-based config overlay.

## Implementation Steps

### Step 1: Zod Settings Schema (1 day)
Create `lib/settingsSchema.ts`:
```ts
import { z } from "zod";

const ProviderConfigSchema = z.object({
  id: z.string(),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  apiFormat: z.enum(["openai", "anthropic", "google"]),
});

const AppSettingsSchema = z.object({
  selectedProvider: z.string().nullable(),
  selectedModel: z.string().nullable(),
  theme: z.enum(["light", "dark", "system"]),
  fontSize: z.number().min(12).max(24),
  // ... all settings fields
});

const TunableConfigSchema = z.object({
  retry: z.object({
    maxRetries: z.number().min(0).max(10).default(2),
    backoffMs: z.number().min(100).max(10000).default(1000),
    backoffFactor: z.number().min(1).max(5).default(2),
  }),
  context: z.object({
    proactivePruneThreshold: z.number().min(0.1).max(0.9).default(0.60),
    proactiveCompactThreshold: z.number().min(0.1).max(0.9).default(0.75),
    tokenCacheMax: z.number().min(100).max(10000).default(1000),
  }),
  memory: z.object({
    maxMemories: z.number().min(100).max(10000).default(500),
    extractionCooldownMs: z.number().min(0).max(60000).default(30000),
  }),
  dream: z.object({
    intervalMs: z.number().min(60000).max(7200000).default(1800000),
    maxLlmCalls: z.number().min(1).max(50).default(10),
  }),
  mcp: z.object({
    defaultTtlMs: z.number().min(60000).max(86400000).default(3600000),
    maxConnections: z.number().min(1).max(50).default(10),
  }),
  skills: z.object({
    maxSkills: z.number().min(10).max(200).default(50),
    crystallizationThreshold: z.number().min(2).max(20).default(5),
  }),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;
export type TunableConfig = z.infer<typeof TunableConfigSchema>;
```

### Step 2: Migration System (1 day)
Create `lib/settingsMigration.ts`:
```ts
interface Migration {
  version: number;
  migrate: (data: Record<string, unknown>) => Record<string, unknown>;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    migrate: (data) => {
      // v0 → v1: rename keys, add defaults
      return { ...data, version: 1 };
    },
  },
  // Add migrations as schema evolves
];

export function migrateSettings(
  data: Record<string, unknown>,
  currentVersion: number
): Record<string, unknown> {
  let result = data;
  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      result = migration.migrate(result);
    }
  }
  return result;
}
```

### Step 3: Move Hardcoded Values to Config (0.5 days)
1. Create `lib/tunableConfig.ts` with defaults from Zod schema
2. Replace all hardcoded values with config lookups:
   ```ts
   // Before
   const MAX_RETRIES = 2;
   
   // After
   import { tunableConfig } from "./tunableConfig";
   const MAX_RETRIES = tunableConfig.retry.maxRetries;
   ```
3. Add settings UI for tunable values (advanced section)

### Step 4: Settings Validation on Load (0.5 days)
1. Update `getStoredSettings()` in `dalamAPI.ts`:
   ```ts
   function getStoredSettings(): AppSettings {
     try {
       const raw = localStorage.getItem(STORAGE_KEYS.settings);
       if (raw) {
         const parsed = JSON.parse(raw);
         const result = AppSettingsSchema.safeParse(parsed);
         if (result.success) return result.data;
         console.warn("Invalid settings, using defaults:", result.error);
       }
     } catch { /* parse failed */ }
     return AppSettingsSchema.parse({});
   }
   ```
2. Add validation for provider configs on save
3. Add validation for MCP server configs
4. Show validation errors in settings UI

### Step 5: Settings Export/Import (0.5 days)
1. Add export button that serializes all `dalam.*` localStorage keys
2. Add import button that deserializes and validates
3. Add file picker for `.json` import
4. Show diff of what will change before importing

### Step 6: Environment Config Overlay (0.5 days)
Create `lib/envConfig.ts`:
```ts
export function getEnvConfig(): Partial<TunableConfig> {
  const env = import.meta.env;
  return {
    retry: {
      maxRetries: env.VITE_MAX_RETRIES ? parseInt(env.VITE_MAX_RETRIES) : undefined,
    },
    // ...
  };
}
```

## Success Criteria

- [ ] All settings validated with Zod on load
- [ ] Migration system handles schema upgrades
- [ ] No hardcoded configuration values in source
- [ ] Settings export/import works
- [ ] Advanced settings UI for tunable values
- [ ] Environment variable overlay for dev/testing

## Configuration Hierarchy

```
Environment Variables (highest priority)
  ↓
User Settings (localStorage)
  ↓
Migrations (transform old → new)
  ↓
Defaults (Zod schema defaults)
```

## Risk Mitigation

- Migration system must handle corrupt data gracefully
- Validation errors should not prevent app startup (use defaults)
- Export must not include API keys (redact sensitive fields)
- Environment config should be dev-only (not exposed in production UI)
