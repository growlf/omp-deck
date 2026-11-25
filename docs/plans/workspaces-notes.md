# Workspace UI notes (W0)

## (a) WorkspaceEntry / ListWorkspacesResponse
- `WorkspaceEntry` at `packages/protocol/src/index.ts:38-42`:
  `interface WorkspaceEntry { cwd: string; label: string; sessionCount: number; }`
- `ListWorkspacesResponse` at `packages/protocol/src/index.ts:66-69`:
  `interface ListWorkspacesResponse { workspaces: WorkspaceEntry[]; defaultCwd: string; }`

## (b) patchEnv signature
- `settingsApi.patchEnv(updates: PatchEnvSettingsRequest["updates"]): Promise<PatchEnvSettingsResponse>`
  at `apps/web/src/lib/settings-api.ts:27`
- Type: `updates: Record<string, string | null>`
- HTTP: `PATCH /settings/env` with body `{ updates: Record<string, string | null> }`
- Returns `PatchEnvSettingsResponse` (extends `ListEnvSettingsResponse` with `appliedHot: string[]`)

## (c) Env value + source exposure
- `GET /settings/env` → `ListEnvSettingsResponse` with `entries: EnvEntry[]`
- `EnvEntry` at `packages/protocol/src/index.ts:79-92`:
  `interface EnvEntry { key: string; masked: string; isSet: boolean; source: EnvValueSource; defaultValue?: string; valueType: EnvValueType; sensitive: boolean; restartRequired: boolean; hotApply: boolean; description: string; options?: string[]; restartTarget?: EnvRestartTarget; }`
- `EnvValueSource = "process-env" | "env-file" | "default" | "unset"` at `packages/protocol/src/index.ts:76`
- UI rendering: `sourceLabel(source)` and `sourceTone(source)` functions in `SettingsView.tsx`

## (d) Does GET workspaces reflect a patchEnv write live? → yes (via hot-update)
- `GET /workspaces` (routes.ts:74-99) reads `config.extraWorkspaces` from the config object.
- `loadConfig()` at `apps/server/src/config.ts:70-109` reads `OMP_DECK_WORKSPACES` from `process.env` at boot and stores in `config.extraWorkspaces`.
- `PATCH /settings/env` calls `applyHotUpdates()` (routes-settings.ts:149-182) which at lines 177-179 does:
  ```ts
  if ("OMP_DECK_WORKSPACES" in updates) {
    config.extraWorkspaces = splitList(effective.get("OMP_DECK_WORKSPACES")).map((p) => path.resolve(p));
  ```
- So the next `GET /workspaces` call sees the updated list without a restart.
- Caveat: `applyHotUpdates` only fires when the key is in `ENV_SCHEMA`. `OMP_DECK_WORKSPACES` IS in the schema (confirmed via grep in env-schema.ts).

## (e) Guard used by mutating routes
- `isLoopbackRequest(req: Request): boolean` at `apps/server/src/routes-settings.ts:184-187`:
  ```ts
  function isLoopbackRequest(req: Request): boolean {
    const host = new URL(req.url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  }
  ```
- Guard applied to: `GET /settings/env/:key?reveal=1` (line 40), `POST /server/restart` (line 90).
- **NOT applied to** `PATCH /settings/env` (the main env write route, lines 56-87).

## (f) Existing folder picker / DirBrowserModal / UI primitives
- `DirBrowserModal`: **does NOT exist**. Grep across `apps/web/src/` returns zero matches.
- `AddWorkspaceModal` has its own inline file-browser UI (Browse tab + Type path tab).
- Existing UI primitives in `apps/web/src/components/ui/`:

| Component | Props |
|-----------|-------|
| `Modal` | `open`, `onClose`, `children`, `widthClass?`, `heightClass?`, `dismissOnBackdrop?`, `dismissOnEscape?` |
| `Badge` | `tone?` (default\|accent\|warn\|danger\|success\|thinking\|muted) |
| `Button` | `variant?` (primary\|ghost\|danger\|outline), `size?` (sm\|md\|icon) |
| `Collapsible` | `header`, `defaultOpen?`, `children`, `className?`, `headerClassName?` |

- No `Input`, `Select`, `Tabs` in the UI directory.

## (g) Already satisfied tasks
All six components and both API methods **already exist as local functions in SettingsView.tsx**:

| Task | Component / Method | Status | Location |
|------|-------------------|--------|----------|
| W5 | `WorkspaceSection` | ✅ exists | `apps/web/src/views/SettingsView.tsx:1932` (local function) |
| W5 | `WorkspaceSectionCard` | ✅ exists | `apps/web/src/views/SettingsView.tsx:2214` (local function) |
| W5 | `WorkspaceCard` | ✅ exists | `apps/web/src/views/SettingsView.tsx:2241` (local function) |
| W6 | `AddWorkspaceModal` | ✅ exists | `apps/web/src/views/SettingsView.tsx:2354` (local function) |
| W7 | `RenameLabelModal` | ✅ exists | `apps/web/src/views/SettingsView.tsx:2652` (local function) |
| W7 | `ConfirmRemoveModal` | ✅ exists | `apps/web/src/views/SettingsView.tsx:2712` (local function) |
| W3 | `api.createDir` | ✅ exists | `apps/web/src/lib/api.ts:91-94` |
| W3 | `api.validatePath` | ✅ exists | `apps/web/src/lib/api.ts:97-100` |

**Server side:**
| Task | Route / Method | Status | Location |
|------|---------------|--------|----------|
| W2 | `POST /fs/mkdir` | ✅ exists | `apps/server/src/routes-fs.ts:77-114` |

**Note:** All UI components are local functions inside `SettingsView.tsx`, not exported as separate files. The spec table at 00-spec.md says "do not reimplement" these — they already exist. Tasks W3, W4, W5, W6, W7, W9 may be partially or fully satisfied depending on whether the expected exported component structure matters.

## (h) Baseline diagnostics (BEFORE changes)
| Gate | Command | Result | Details |
|------|---------|--------|---------|
| TC | `bun run --filter '@omp-deck/protocol' typecheck && bun run --filter '@omp-deck/server' typecheck && bun run --filter '@omp-deck/web' typecheck` | **PASS** | Zero errors across all 3 packages |
| TS | `cd apps/server && bun test` | **FAIL** (pre-existing) | 177 pass, 1 fail, 178 total (21 files). Failure: `(fail) start command > missing file returns exists=false with empty fields` in `orientation-store.test.ts:94` |
| TW | `cd apps/web && bun test` | **PASS** | 127 pass, 0 fail, 127 total (13 files) |

## (i) Working gate commands
| Gate | Command |
|------|---------|
| TC | `bun run --filter '@omp-deck/protocol' typecheck && bun run --filter '@omp-deck/server' typecheck && bun run --filter '@omp-deck/web' typecheck` |
| TS | `cd apps/server && bun test` |
| TW | `cd apps/web && bun test` |

## Open questions
- None. All scout assignments completed.
