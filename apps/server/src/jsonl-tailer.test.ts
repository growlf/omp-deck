import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readJsonlHeader,
  readJsonlEntries,
  isRecentlyModified,
  archiveSessionFile,
  rewriteSessionTitle,
} from "./jsonl-tailer.ts";

describe("jsonl-tailer", () => {
  let tmpDir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-tailer-test-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    delete process.env.USERPROFILE;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSessionFile(name: string, lines: string[]): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, lines.join("\n"), "utf8");
    return file;
  }

  test("archiveSessionFile moves a session file into the env-resolved home", () => {
    const file = writeSessionFile("session-a.jsonl", [
      JSON.stringify({ type: "session", id: "a", title: "A", cwd: "/tmp", timestamp: "2026-01-01" }),
    ]);
    const result = archiveSessionFile(file);
    expect(result.error).toBeUndefined();
    expect(result.archivedTo).toBeDefined();
    expect(result.archivedTo).toContain(tmpDir);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(result.archivedTo!)).toBe(true);
  });

  test("archiveSessionFile collision: second archive gets .1 suffix, first untouched", () => {
    const first = writeSessionFile("dup.jsonl", [
      JSON.stringify({ type: "session", id: "a", cwd: "/tmp" }),
    ]);
    const r1 = archiveSessionFile(first);
    expect(r1.error).toBeUndefined();

    const second = writeSessionFile("dup.jsonl", [
      JSON.stringify({ type: "session", id: "b", cwd: "/tmp" }),
    ]);
    const r2 = archiveSessionFile(second);
    expect(r2.error).toBeUndefined();
    expect(r2.archivedTo).toBeDefined();
    expect(r2.archivedTo).not.toBe(r1.archivedTo);
    expect(path.basename(r2.archivedTo!)).toBe("dup.1.jsonl");
    expect(fs.existsSync(r1.archivedTo!)).toBe(true);
    expect(fs.existsSync(r2.archivedTo!)).toBe(true);
  });

  test("readJsonlHeader: older file with session entry on line 1", () => {
    const file = writeSessionFile("older.jsonl", [
      JSON.stringify({ type: "session", id: "older", title: "Old", cwd: "/tmp/old", timestamp: "2026-01-01", version: 1 }),
    ]);
    const header = readJsonlHeader(file);
    expect(header).not.toBeNull();
    expect(header!.id).toBe("older");
    expect(header!.title).toBe("Old");
    expect(header!.cwd).toBe("/tmp/old");
  });

  test("readJsonlHeader: newer file with auto-generated title record before the session entry", () => {
    const file = writeSessionFile("newer.jsonl", [
      JSON.stringify({ type: "title", title: "Auto", source: "auto" }),
      JSON.stringify({ type: "session", id: "new", title: "New", cwd: "/tmp/new", timestamp: "2026-01-02" }),
    ]);
    const header = readJsonlHeader(file);
    expect(header).not.toBeNull();
    expect(header!.id).toBe("new");
    expect(header!.title).toBe("New");
    expect(header!.cwd).toBe("/tmp/new");
  });

  test("readJsonlHeader: unreadable / missing file returns null", () => {
    expect(readJsonlHeader(path.join(tmpDir, "does-not-exist.jsonl"))).toBeNull();
  });

  test("readJsonlEntries: skips malformed JSON lines and returns parseable entries in order", () => {
    const file = writeSessionFile("entries.jsonl", [
      JSON.stringify({ type: "session", id: "s", cwd: "/tmp" }),
      "not json at all",
      JSON.stringify({ type: "message", id: "m1", role: "user" }),
      "{broken",
      JSON.stringify({ type: "message", id: "m2", role: "assistant" }),
    ]);
    const entries = readJsonlEntries(file);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.type).toBe("session");
    expect(entries[1]!.id).toBe("m1");
    expect(entries[2]!.id).toBe("m2");
  });

  test("isRecentlyModified: true when mtime is recent", () => {
    const file = writeSessionFile("recent.jsonl", [JSON.stringify({ type: "session", id: "r" })]);
    expect(isRecentlyModified(file, 120_000)).toBe(true);
  });

  test("isRecentlyModified: false when mtime is older than windowMs", () => {
    const file = writeSessionFile("old.jsonl", [JSON.stringify({ type: "session", id: "o" })]);
    const past = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(file, past, past);
    expect(isRecentlyModified(file, 120_000)).toBe(false);
  });

  test("rewriteSessionTitle: header on line 1 — title rewritten, titleSource user, other fields preserved", () => {
    const file = writeSessionFile("title.jsonl", [
      JSON.stringify({ type: "session", id: "abc", title: "Old", cwd: "/tmp/abc", timestamp: "2026-01-01", version: 1 }),
    ]);
    rewriteSessionTitle(file, "New");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const header = JSON.parse(lines[0]!);
    expect(header.title).toBe("New");
    expect(header.titleSource).toBe("user");
    expect(header.id).toBe("abc");
    expect(header.cwd).toBe("/tmp/abc");
    expect(header.timestamp).toBe("2026-01-01");
    expect(header.version).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  test("rewriteSessionTitle: title lands on the session header, not the auto title record", () => {
    const file = writeSessionFile("title-auto.jsonl", [
      JSON.stringify({ type: "title", title: "Auto", source: "auto" }),
      JSON.stringify({ type: "session", id: "xyz", title: "Old", cwd: "/tmp/xyz", timestamp: "2026-01-02" }),
    ]);
    rewriteSessionTitle(file, "New");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const titleRec = JSON.parse(lines[0]!);
    const sessionRec = JSON.parse(lines[1]!);
    expect(titleRec.title).toBe("Auto");
    expect(sessionRec.title).toBe("New");
    expect(sessionRec.titleSource).toBe("user");
    expect(sessionRec.id).toBe("xyz");
  });
});
