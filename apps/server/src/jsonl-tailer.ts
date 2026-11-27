/**
 * JSONL session-file tailer.
 *
 * Deck-owned in-process sessions are tracked by the SDK (which owns the file
 * format); sessions owned by *external* omp processes are read + followed
 * from disk. This module provides the disk-reading + polling half of that:
 *
 * - `readJsonlHeader` / `readJsonlEntries` / `readRecentMessages` for
 *   snapshot building,
 * - `isRecentlyModified` for the live-writer guard before destructive ops,
 * - `archiveSessionFile` for the archive endpoint,
 * - `rewriteSessionTitle` for deck-managed renames on resumed sessions,
 * - `tailJsonl` — polls a JSONL file every ~500ms and emits one event per
 *   new entry. Tracks dev+ino to detect atomic file replacement, resets
 *   tracking on inode change, and dedupes by entry id.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveHome } from "./resolve-home.ts";

const ARCHIVE_DIR_NAME = "sessions-archive";
const DEFAULT_WINDOW_MS = 120_000;
const POLL_INTERVAL_MS = 500;

export interface JsonlHeader {
	id?: string;
	title?: string;
	cwd?: string;
	timestamp?: string;
	version?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the session header from a JSONL file. The header is the first entry
 * whose `type === "session"` — older files carry it on line 1, newer ones
 * put an auto-generated `{"type":"title",...}` record first. Returns null
 * when the file is unreadable or contains no session header.
 */
export function readJsonlHeader(filePath: string): JsonlHeader | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(entry)) continue;
		if (entry.type !== "session") continue;
		const header: JsonlHeader = {};
		if (typeof entry.id === "string") header.id = entry.id;
		if (typeof entry.title === "string") header.title = entry.title;
		if (typeof entry.cwd === "string") header.cwd = entry.cwd;
		if (typeof entry.timestamp === "string") header.timestamp = entry.timestamp;
		if (typeof entry.version === "number") header.version = entry.version;
		return header;
	}
	return null;
}

/**
 * Parse every JSON line in the file, skipping lines that don't parse.
 * Entries are returned in file order. Entries are NOT deduped here — the
 * caller decides.
 */
export function readJsonlEntries(filePath: string): Array<Record<string, unknown>> {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return [];
	}
	const out: Array<Record<string, unknown>> = [];
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (isRecord(entry)) out.push(entry);
	}
	return out;
}

export interface RecentMessages {
	messages: Array<Record<string, unknown>>;
	updatedAt?: string;
	title?: string;
	cwd?: string;
	id?: string;
}

/**
 * Read the header + every `message` entry from a JSONL file. Messages are
 * returned in file order with their raw payloads (the parsed `message`
 * field) for snapshot building.
 */
export function readRecentMessages(filePath: string): RecentMessages {
	const header = readJsonlHeader(filePath);
	const entries = readJsonlEntries(filePath);
	const messages: Array<Record<string, unknown>> = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (isRecord(message)) messages.push(message);
		else messages.push(entry);
	}
	let updatedAt: string | undefined;
	for (const entry of entries) {
		if (typeof entry.timestamp === "string") updatedAt = entry.timestamp;
		else if (isRecord(entry.message) && typeof entry.message.timestamp === "string") {
			updatedAt = entry.message.timestamp;
		}
	}
	if (!updatedAt && header?.timestamp) updatedAt = header.timestamp;
	return {
		messages,
		updatedAt,
		title: header?.title,
		cwd: header?.cwd,
		id: header?.id,
	};
}

/** True when the file's mtime is within `windowMs` of now. False on error. */
export function isRecentlyModified(filePath: string, windowMs: number = DEFAULT_WINDOW_MS): boolean {
	try {
		const st = fs.statSync(filePath);
		return Date.now() - st.mtimeMs < windowMs;
	} catch {
		return false;
	}
}

export interface ArchiveResult {
	archivedTo: string | null;
	error?: string;
}

/**
 * Move a JSONL session file into ~/.omp/agent/sessions-archive/. Never
 * overwrites an existing archive file — if the basename is taken a numeric
 * suffix is appended (`.1`, `.2`, ...). Returns the archived path or an error.
 */
export function archiveSessionFile(filePath: string): ArchiveResult {
	const dir = path.join(resolveHome(), ".omp", "agent", ARCHIVE_DIR_NAME);
	try {
		fs.mkdirSync(dir, { recursive: true });
		const basename = path.basename(filePath);
		const ext = path.extname(basename);
		const stem = ext ? basename.slice(0, basename.length - ext.length) : basename;
		let target = path.join(dir, basename);
		let n = 1;
		while (fs.existsSync(target)) {
			target = path.join(dir, `${stem}.${n}${ext}`);
			n += 1;
		}
		fs.renameSync(filePath, target);
		return { archivedTo: target };
	} catch (err) {
		return { archivedTo: null, error: String((err as Error)?.message ?? err) };
	}
}

/**
 * Rewrite the session header in place to set `title` and
 * `titleSource: "user"`, keeping every other header field. The file is
 * written in place (same inode) so a concurrent tailer keeps following the
 * file; the poller handles shrinkage by resetting its offset.
 */
export function rewriteSessionTitle(filePath: string, title: string): void {
	const content = fs.readFileSync(filePath, "utf8");
	const newLines: string[] = [];
	let touched = false;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			newLines.push(rawLine);
			continue;
		}
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			newLines.push(rawLine);
			continue;
		}
		if (isRecord(entry) && entry.type === "session") {
			newLines.push(JSON.stringify({ ...entry, title, titleSource: "user" }));
			touched = true;
			continue;
		}
		newLines.push(rawLine);
	}
	if (!touched) {
		throw new Error(`no session header found in ${filePath}`);
	}
	fs.writeFileSync(filePath, newLines.join("\n"), "utf8");
}

export interface TailEvent {
	type: string;
	raw: Record<string, unknown>;
}

export interface TailOptions {
	onEvent: (event: TailEvent) => void;
	onError?: (err: unknown) => void;
}

/**
 * Poll a JSONL file every ~500ms and emit one event per newly-appended
 * entry. The initial offset is the current file size, so pre-subscribe
 * entries are not replayed to the listener.
 *
 * - dev+ino tracked via statSync; inode change → reset offset to 0 (dedupe kept).
 * - Size decrease (in-place rewrite) → reset the offset to 0 (dedupe kept,
 *   so rewritten entries are not re-emitted).
 * - Entries are deduped by `id` across the whole tail.
 * - On ENOENT (file deleted) → emit nothing and teardown.
 * - Unparseable lines are skipped; the file is kept tailing.
 *
 * Returns a teardown function. Safe to call more than once.
 */
export function tailJsonl(filePath: string, opts: TailOptions): () => void {
	const { onEvent, onError } = opts;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let initialized = false;
	let dev = 0n;
	let ino = 0n;
	let offset = 0;
	const seen = new Map<string, true>();

	const teardown = (): void => {
		if (stopped) return;
		stopped = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const emitEntry = (entry: Record<string, unknown>): void => {
		const id = typeof entry.id === "string" ? entry.id : undefined;
		if (id) {
			if (seen.has(id)) return;
			seen.set(id, true);
		}
		try {
			onEvent({ type: String(entry.type ?? "unknown"), raw: entry });
		} catch (err) {
			try {
				onError?.(err);
			} catch {
				// ignore errors from the error handler
			}
		}
	};

	const parseChunk = (bytes: Buffer, startOffset: number): number => {
		// Only parse up to the last newline — an incomplete trailing line might
		// still be appended, so it stays unread for the next poll.
		let lastNl = -1;
		for (let i = bytes.length - 1; i >= 0; i--) {
			if (bytes[i] === 0x0a) {
				lastNl = i;
				break;
			}
		}
		if (lastNl === -1) return startOffset; // no complete line yet — wait
		const chunk = bytes.subarray(0, lastNl + 1).toString("utf8");
		for (const line of chunk.split(/\r?\n/)) {
			const t = line.trim();
			if (!t) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(t);
			} catch {
				continue; // skip unparseable line; keep tailing
			}
			if (!isRecord(entry)) continue;
			emitEntry(entry);
		}
		return startOffset + lastNl + 1;
	};

	const tick = (): void => {
		if (stopped) return;
		try {
			const st = fs.statSync(filePath, { bigint: true });
			const curDev = st.dev;
			const curIno = st.ino;
			const size = Number(st.size);
			if (!initialized) {
				dev = curDev;
				ino = curIno;
				offset = size; // don't replay pre-subscribe entries
				initialized = true;
			} else if (curDev !== dev || curIno !== ino) {
				// File replaced (e.g. atomic rename). Keep dedupe map — entries already emitted stay deduped; reset offset only.
				dev = curDev;
				ino = curIno;
				offset = 0;
			} else if (size < offset) {
				// In-place rewrite shrank the file — re-read from byte 0. The
				// dedupe map is kept so rewritten entries are not re-emitted.
				offset = 0;
			}
			if (size > offset) {
				const fd = fs.openSync(filePath, "r");
				try {
					const len = size - offset;
					const buf = Buffer.alloc(len);
					fs.readSync(fd, buf, 0, len, offset);
					offset = parseChunk(buf, offset);
				} finally {
					fs.closeSync(fd);
				}
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
				// File deleted (archived/disposed). Emit nothing; teardown.
				teardown();
				return;
			}
			try {
				onError?.(err);
			} catch {
				// ignore errors from the error handler
			}
		}
		if (stopped) return;
		timer = setTimeout(tick, POLL_INTERVAL_MS);
	};

	timer = setTimeout(tick, 50);
	return teardown;
}
