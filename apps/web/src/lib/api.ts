import type {
	CreateSessionRequest,
	CreateSessionResponse,
	ListFilePathsResponse,
	ListModelsResponse,
	ListSessionsResponse,
	ListSlashCommandsResponse,
	ListWorkspacesResponse,
	ModelRef,
} from "@omp-deck/protocol";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	if (!res.ok) {
		let body: string;
		try {
			body = await res.text();
		} catch {
			body = "(unreadable body)";
		}
		throw new Error(`HTTP ${res.status} ${path}: ${body}`);
	}
	return (await res.json()) as T;
}

export const api = {
	listWorkspaces(): Promise<ListWorkspacesResponse> {
		return request<ListWorkspacesResponse>("/workspaces");
	},
	listSessions(cwd?: string): Promise<ListSessionsResponse> {
		const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
		return request<ListSessionsResponse>(`/sessions${q}`);
	},
	createSession(body: CreateSessionRequest): Promise<CreateSessionResponse> {
		return request<CreateSessionResponse>("/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	abortSession(id: string): Promise<{ ok: true }> {
		return request(`/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" });
	},
	renameSession(id: string, name: string): Promise<{ ok: true; sessionId: string }> {
		return request(`/sessions/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ name }),
		});
	},
	listModels(sessionId?: string): Promise<ListModelsResponse> {
		const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
		return request<ListModelsResponse>(`/models${q}`);
	},
	setSessionModel(id: string, model: ModelRef): Promise<{ ok: true; sessionId: string }> {
		return request(`/sessions/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ model }),
		});
	},
	compactSession(id: string, focus?: string): Promise<{ ok: true }> {
		const body = focus && focus.trim().length > 0 ? JSON.stringify({ focus: focus.trim() }) : "";
		const init: RequestInit = { method: "POST" };
		if (body) {
			init.body = body;
			init.headers = { "content-type": "application/json" };
		}
		return request(`/sessions/${encodeURIComponent(id)}/compact`, init);
	},
	disposeSession(id: string): Promise<{ ok: true }> {
		return request(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	listSlashCommands(cwd?: string): Promise<ListSlashCommandsResponse> {
		const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
		return request<ListSlashCommandsResponse>(`/slash-commands${q}`);
	},
	completeFilePath(cwd: string, q: string, limit = 20): Promise<ListFilePathsResponse> {
		const params = new URLSearchParams({ cwd, q, limit: String(limit) });
		return request<ListFilePathsResponse>(`/fs/complete?${params.toString()}`);
	},
	browseDir(path: string, limit = 500): Promise<{ entries: { path: string; name: string; isDir: boolean }[] }> {
		const params = new URLSearchParams({ path, limit: String(limit) });
		return request<{ entries: { path: string; name: string; isDir: boolean }[] }>(`/fs/browse?${params.toString()}`);
	},
	createDir(path: string): Promise<{ ok: true }> {
		return request("/fs/mkdir", {
			method: "POST",
			body: JSON.stringify({ path }),
		});
	},
	validatePath(path: string): Promise<{ ok: true }> {
		// Reuse browseDir — if it succeeds (even with 0 entries), the dir exists.
		// If it fails with "cannot read directory", the path doesn't exist.
		return this.browseDir(path, 1).then(() => ({ ok: true }));
	},
};
