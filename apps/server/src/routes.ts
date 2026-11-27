import { Hono } from "hono";
import type {
	CreateSessionRequest,
	CreateSessionResponse,
	ListModelsResponse,
	ListSessionsResponse,
	ListWorkspacesResponse,
	RestartServerResponse,
	WorkspaceEntry,
} from "@omp-deck/protocol";

import type { Config } from "./config.ts";
import { logger } from "./log.ts";
import { getBuildInfo, getUptimeSecs } from "./build-info.ts";
import { getUpdateCheck } from "./update-check.ts";
import type { AgentBridge, SessionHandle } from "./bridge/types.ts";
import fs from "node:fs";
import { archiveSessionFile, isRecentlyModified, rewriteSessionTitle } from "./jsonl-tailer.ts";

const log = logger("routes");

import { buildTasksRouter } from "./routes-tasks.ts";
import { buildSettingsRouter } from "./routes-settings.ts";
import { buildRoutinesRouter } from "./routes-routines.ts";
import { buildHooksRouter } from "./routes-hooks.ts";
import { buildInboxRouter } from "./routes-inbox.ts";
import { buildUtilityRouter } from "./routes-cron.ts";
import { buildSlashCommandsRouter } from "./routes-slash-commands.ts";
import { buildFsRouter } from "./routes-fs.ts";
import { buildBridgesRouter } from "./routes-bridges.ts";
import { buildMarketplaceRouter } from "./routes-marketplace.ts";
import { buildSkillsRouter } from "./routes-skills.ts";
import { buildKbRouter } from "./routes-kb.ts";
import { buildUploadsRouter } from "./routes-uploads.ts";
import { buildOrientationRouter } from "./routes-orientation.ts";
import { buildAuthOAuthRouter } from "./routes-auth-oauth.ts";
import { buildOnboardingRouter } from "./routes-onboarding.ts";
import type { RoutinesRunner } from "./routines-runner.ts";
import type { BridgeSupervisor } from "./bridge-supervisor.ts";
import type { MarketplaceService } from "./marketplace-service.ts";
import type { SkillsService } from "./skills-service.ts";
import type { KbService } from "./kb-service.ts";

const LIVE_WRITER_WINDOW_MS = 120_000;

function liveWriterGuardError(filePath: string): string | undefined {
	if (isRecentlyModified(filePath, LIVE_WRITER_WINDOW_MS)) {
		return "session updated within the last 2 minutes — external process may still be writing; stop it first";
	}
	return undefined;
}

async function resolveSessionFile(
	bridge: AgentBridge,
	id: string,
): Promise<{ filePath?: string; handle: SessionHandle | undefined }> {
	const handle = bridge.getSession(id);
	if (handle?.sessionFile) return { filePath: handle.sessionFile, handle };
	try {
		const sessions = await bridge.listSessions({});
		const summary = sessions.find((s) => s.id === id);
		if (summary?.path) return { filePath: summary.path, handle: undefined };
	} catch {
		// listSessions is best-effort — fall through.
	}
	return { filePath: undefined, handle: undefined };
}

export function buildRouter(
	bridge: AgentBridge,
	config: Config,
	runner: RoutinesRunner,
	supervisor: BridgeSupervisor,
	marketplace: MarketplaceService,
	skills: SkillsService,
	kb: KbService,
	opts: { restartServer?: () => RestartServerResponse } = {},
): Hono {
	const app = new Hono();

	app.get("/health", (c) => {
		const info = getBuildInfo();
		return c.json({
			ok: true,
			pid: info.pid,
			defaultCwd: config.defaultCwd,
			extraWorkspaces: config.extraWorkspaces,
			serverStartedAt: info.serverStartedAt,
			version: info.version,
			buildSha: info.buildSha,
			uptimeSecs: getUptimeSecs(),
		});
	});

	app.get("/version", async (c) => {
		const info = getBuildInfo();
		const body = await getUpdateCheck({ currentVersion: info.version });
		return c.json(body);
	});

	app.get("/workspaces", async (c) => {
		const allSessions = await bridge.listSessions({});
		const counts = new Map<string, number>();
		for (const s of allSessions) {
			if (!s.cwd) continue;
			counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
		}

		// Always include default + extras even if zero sessions.
		const known = new Set<string>([config.defaultCwd, ...config.extraWorkspaces]);
		for (const cwd of counts.keys()) known.add(cwd);

		const workspaces: WorkspaceEntry[] = Array.from(known)
			.map((cwd) => ({
				cwd,
				label: deriveLabel(cwd),
				sessionCount: counts.get(cwd) ?? 0,
			}))
			.sort((a, b) => b.sessionCount - a.sessionCount || a.label.localeCompare(b.label));

		const body: ListWorkspacesResponse = {
			workspaces,
			defaultCwd: config.defaultCwd,
		};
		return c.json(body);
	});

	app.get("/sessions", async (c) => {
		const cwd = c.req.query("cwd");
		try {
			const sessions = await bridge.listSessions(cwd ? { cwd } : {});
			const body: ListSessionsResponse = { sessions };
			return c.json(body);
		} catch (err) {
			log.error(`listSessions failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions", async (c) => {
		let body: CreateSessionRequest;
		try {
			body = (await c.req.json()) as CreateSessionRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		const cwd = body.cwd?.trim() || config.defaultCwd;

		try {
			const handle = body.resumeFromPath
				? await bridge.resumeSession({
						sessionPath: body.resumeFromPath,
						...(body.external ? { external: true } : {}),
					})
				: await bridge.createSession({
						cwd,
						...(body.model ? { model: body.model } : {}),
						...(body.suppressAutoStart ? { suppressAutoStart: true } : {}),
					});
			const resp: CreateSessionResponse = {
				sessionId: handle.sessionId,
				sessionFile: handle.sessionFile,
				cwd: handle.cwd,
			};
			return c.json(resp);
		} catch (err) {
			log.error(`createSession failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions/:id/abort", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found" }, 404);
		if (handle.isResumed) return c.json({ error: "session owned by an external omp process — read-only" }, 409);
		try {
			await handle.abort();
			return c.json({ ok: true });
		} catch (err) {
			log.error(`abort failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions/:id/compact", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found" }, 404);
		if (handle.isResumed) return c.json({ error: "session owned by an external omp process — read-only" }, 409);
		// Body is optional — accept missing/empty JSON without bouncing.
		let body: { focus?: string } = {};
		try {
			const raw = await c.req.text();
			if (raw.trim().length > 0) body = JSON.parse(raw) as { focus?: string };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			await handle.compact(body.focus);
			return c.json({ ok: true });
		} catch (err) {
			log.error(`compact failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.patch("/sessions/:id", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found or not active" }, 404);
		let body: { name?: string; model?: { provider?: unknown; id?: unknown } };
		try {
			body = (await c.req.json()) as { name?: string; model?: { provider?: unknown; id?: unknown } };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			if (typeof body.name === "string") {
				const trimmed = body.name.trim();
				if (handle.isResumed) {
					const filePath = handle.sessionFile;
					if (!filePath) return c.json({ error: "session file not found" }, 404);
					const guard = liveWriterGuardError(filePath);
					if (guard) return c.json({ error: guard }, 409);
					try {
						rewriteSessionTitle(filePath, trimmed);
					} catch (err) {
						return c.json({ error: String(err) }, 500);
					}
					handle.emitSessionUpdated();
				} else {
					await handle.setName(trimmed);
				}
			}
			if (body.model && typeof body.model === "object") {
				if (handle.isResumed) {
					return c.json({ error: "session is read-only (owned by an external omp process)" }, 409);
				}
				const provider = typeof body.model.provider === "string" ? body.model.provider : "";
				const modelId = typeof body.model.id === "string" ? body.model.id : "";
				if (!provider || !modelId) {
					return c.json({ error: "model requires provider and id strings" }, 400);
				}
				await handle.setModel({ provider, id: modelId });
			}
			return c.json({ ok: true, sessionId: id });
		} catch (err) {
			log.error(`patch session failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.get("/models", async (c) => {
		const sessionId = c.req.query("sessionId");
		try {
			const opts: { sessionId?: string } = {};
			if (sessionId) opts.sessionId = sessionId;
			const models = await bridge.listModels(opts);
			const active = models.find((m) => m.isCurrent);
			const body: ListModelsResponse = {
				models,
				...(active ? { active: { provider: active.provider, id: active.id } } : {}),
			};
			return c.json(body);
		} catch (err) {
			log.error(`listModels failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.delete("/sessions/:id", async (c) => {
		const id = c.req.param("id");
		const { filePath, handle } = await resolveSessionFile(bridge, id);
		if (!handle && !filePath) return c.json({ error: "session not found" }, 404);
		if (handle?.isResumed && filePath) {
			const guard = liveWriterGuardError(filePath);
			if (guard) return c.json({ error: guard }, 409);
		}
		try {
			if (handle) await handle.dispose();
		} catch (err) {
			log.error(`dispose failed`, err);
			return c.json({ error: String(err) }, 500);
		}
		return c.json({ ok: true });
	});

	app.post("/sessions/:id/archive", async (c) => {
		const id = c.req.param("id");
		const { filePath, handle } = await resolveSessionFile(bridge, id);
		if (!filePath) return c.json({ error: "session not found" }, 404);
		if (!fs.existsSync(filePath)) {
			return c.json({ error: "session file not found" }, 404);
		}
		const guard = liveWriterGuardError(filePath);
		if (guard) return c.json({ error: guard }, 409);
		const result = archiveSessionFile(filePath);
		if (result.error) return c.json({ error: result.error }, 500);
		if (handle) {
			try {
				await handle.dispose();
			} catch (err) {
				log.error(`dispose after archive failed`, err);
			}
		}
		return c.json({ archivedTo: result.archivedTo });
	});

	app.route("/", buildTasksRouter());
	app.route("/", buildUploadsRouter({ uploadsRoot: config.uploadsRoot }));
	app.route("/", buildRoutinesRouter(runner));
	app.route("/", buildHooksRouter(runner));
	app.route("/", buildInboxRouter());
	app.route("/", buildUtilityRouter());
	app.route("/", buildSlashCommandsRouter());
	app.route("/", buildFsRouter());
	app.route("/", buildSettingsRouter(bridge, config, opts));
	app.route("/", buildOrientationRouter());
	app.route("/", buildBridgesRouter(supervisor));
	app.route("/", buildMarketplaceRouter(marketplace));
	app.route("/", buildSkillsRouter(skills));
	app.route("/", buildKbRouter(kb));
	app.route("/auth/oauth", buildAuthOAuthRouter());
	app.route("/onboarding", buildOnboardingRouter());

	return app;
}

function deriveLabel(cwd: string): string {
	if (!cwd) return "(unknown)";
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}
