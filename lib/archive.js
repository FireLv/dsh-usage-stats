/**
 * dsh-usage-stats — detached-session archive.
 *
 * Keeps the per-day, per-model token contribution of sessions that no longer
 * exist (deleted conversations) in a file separate from the incremental fold
 * cache:
 *
 *   <DSH_HOME>/storages/usage-stats-archive.json
 *
 * The fold cache (`usage-stats-cache.json`) only tracks sessions the host can
 * still enumerate; when a session disappears its folded days move here and
 * keep contributing to every usage response. Keeping the archive in its own
 * file means a cache-version bump or a corrupt cache rebuild cannot erase the
 * history of deleted conversations.
 *
 * Restore semantics: when the same session id becomes enumerable again, the
 * caller folds the live/stored log first and only then drops the archive
 * entry, so a failed restore never loses the archived contribution.
 *
 * In memory the archive holds Maps (id → { detachedAt, days: Map<date, entry> })
 * so merging stays as cheap as merging a live session; only disk I/O uses the
 * plain-object JSON form.
 *
 * @module dsh-usage-stats/archive
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { mergeInto, zeroBuckets } from "./usage.js";

/** Archive file format version (bump only on an incompatible layout change). */
const ARCHIVE_VERSION = 1;

/** Same retention as the live fold: 12 calendar months plus slack. */
export const MAX_ARCHIVED_DAYS = 400;

/** Upper bound on retained deleted-session records (oldest evicted first). */
export const MAX_ARCHIVED_SESSIONS = 2000;

/** Archive file location under the dsh home. */
export function archivePath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "storages", "usage-stats-archive.json");
}

/** Empty archive value. */
export function emptyArchive() {
	return { sessions: new Map() };
}

/** Serialize one session's day map (Maps → plain objects). */
export function serializeDays(days) {
	const out = {};
	for (const [date, entry] of days) {
		const models = {};
		for (const [model, buckets] of entry.models) models[model] = { ...buckets };
		out[date] = { totals: { ...entry.totals }, models };
	}
	return out;
}

/** Parse a serialized day map back into Maps (lenient). */
export function parseDays(raw) {
	const days = new Map();
	if (raw === null || typeof raw !== "object") return days;
	for (const [date, entry] of Object.entries(raw)) {
		if (entry === null || typeof entry !== "object") continue;
		const target = { totals: zeroBuckets(), models: new Map() };
		const totals = entry.totals;
		if (totals !== null && typeof totals === "object") {
			target.totals.inputTokens = Number.isFinite(totals.inputTokens) ? totals.inputTokens : 0;
			target.totals.outputTokens = Number.isFinite(totals.outputTokens) ? totals.outputTokens : 0;
			target.totals.cacheReadTokens = Number.isFinite(totals.cacheReadTokens) ? totals.cacheReadTokens : 0;
			target.totals.cacheWriteTokens = Number.isFinite(totals.cacheWriteTokens) ? totals.cacheWriteTokens : 0;
		}
		if (entry.models !== null && typeof entry.models === "object") {
			for (const [model, buckets] of Object.entries(entry.models)) {
				if (buckets === null || typeof buckets !== "object") continue;
				target.models.set(model, {
					inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
					outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
					cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
					cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
				});
			}
		}
		days.set(date, target);
	}
	return days;
}

/** Drop the oldest date keys until the map fits the retention limit. */
export function trimDayMap(days, limit = MAX_ARCHIVED_DAYS) {
	while (days.size > limit) {
		let oldest;
		for (const key of days.keys()) {
			if (oldest === void 0 || key < oldest) oldest = key;
		}
		if (oldest === void 0) break;
		days.delete(oldest);
	}
	return days;
}

/**
 * Store (replace) one deleted session's folded days.
 * Replacement rather than accumulation keeps repeated archival idempotent.
 */
export function putArchiveSession(archive, id, days, now = Date.now()) {
	if (days === null || days.size === 0) return false;
	trimDayMap(days);
	if (days.size === 0) return false;
	archive.sessions.set(id, {
		detachedAt: now,
		days
	});
	return true;
}

/** Drop one session's archive record; returns whether it existed. */
export function deleteArchiveSession(archive, id) {
	return archive.sessions.delete(id);
}

/** Whether an archived record exists for this session id. */
export function hasArchiveSession(archive, id) {
	return archive.sessions.has(id);
}

/** Merge every archived session's days into the global per-day map. */
export function mergeArchiveInto(byDay, archive) {
	for (const record of archive.sessions.values()) {
		if (record === null || typeof record !== "object" || !(record.days instanceof Map)) continue;
		if (record.days.size > 0) mergeInto(byDay, record.days);
	}
}

/**
 * Bound the archive: trim every record to the day limit, drop empty records,
 * then evict the oldest records beyond the session limit.
 */
export function trimArchive(archive) {
	for (const [id, record] of archive.sessions) {
		if (record === null || typeof record !== "object" || !(record.days instanceof Map)) {
			archive.sessions.delete(id);
			continue;
		}
		trimDayMap(record.days);
		if (record.days.size === 0) archive.sessions.delete(id);
	}
	if (archive.sessions.size <= MAX_ARCHIVED_SESSIONS) return archive;
	const entries = [...archive.sessions.entries()];
	entries.sort((a, b) => (Number(a[1]?.detachedAt) || 0) - (Number(b[1]?.detachedAt) || 0));
	for (const [id] of entries.slice(0, entries.length - MAX_ARCHIVED_SESSIONS)) archive.sessions.delete(id);
	return archive;
}

/** Load the archive; any corruption degrades to an empty archive. */
export async function loadArchive() {
	try {
		const parsed = JSON.parse(await readFile(archivePath(), "utf8"));
		if (parsed !== null && typeof parsed === "object" && parsed.version === ARCHIVE_VERSION && parsed.sessions !== null && typeof parsed.sessions === "object") {
			const sessions = new Map();
			for (const [id, record] of Object.entries(parsed.sessions)) {
				if (typeof id !== "string" || id.length === 0 || record === null || typeof record !== "object") continue;
				const days = parseDays(record.days);
				trimDayMap(days);
				if (days.size === 0) continue;
				sessions.set(id, {
					detachedAt: Number.isFinite(record.detachedAt) ? record.detachedAt : 0,
					days
				});
			}
			return { sessions };
		}
	} catch {
		/* first run or unreadable/corrupt archive */
	}
	return emptyArchive();
}

/** Persist the archive atomically (temp + rename). */
export async function saveArchive(archive) {
	const path = archivePath();
	await mkdir(dirname(path), { recursive: true });
	const sessions = {};
	for (const [id, record] of archive.sessions) {
		sessions[id] = {
			detachedAt: record.detachedAt,
			days: serializeDays(record.days)
		};
	}
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify({ version: ARCHIVE_VERSION, sessions }), "utf8");
	await rename(tmp, path);
}
