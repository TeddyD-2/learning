// log.js — the markdown session log. Replaces the Obsidian vault: the agent
// mirrors every teaching message into a plain .md file, and the browser UI
// renders that same markdown live (LaTeX + mermaid included).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Anchored to the project, not to wherever Claude Code happened to launch us.
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.LEARN_SESSIONS_DIR || path.join(PROJECT_ROOT, "sessions");

let file = null;
let title = null;

function stamp(d = new Date()) {
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function slug(s) {
	return (
		s
			// "Thévenin's" -> "thevenins", not "th-venin-s".
			.normalize("NFD")
			.replace(/\p{Diacritic}/gu, "")
			.toLowerCase()
			.replace(/['’]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 48)
			.replace(/-$/, "") || "session"
	);
}

function ensureFile() {
	if (file) return file;
	fs.mkdirSync(ROOT, { recursive: true });
	const name = `${stamp()}${title ? `-${slug(title)}` : ""}.md`;
	file = path.join(ROOT, name);
	fs.writeFileSync(file, `# ${title || "Learning session"}\n\n_${new Date().toLocaleString()}_\n\n`, "utf8");
	return file;
}

/**
 * Name the session. A probe phase opens with quizzes, so the file often exists
 * before the agent gets round to naming it — in that case rename it rather than
 * leaving an untitled log.
 */
export function setTitle(t) {
	if (title) return file;
	title = t;
	if (!file) return null;
	try {
		// Retitle the heading as well as the filename, so the log doesn't say
		// "Learning session" at the top of a named lesson.
		const body = fs.readFileSync(file, "utf8").replace(/^# .*$/m, `# ${t}`);
		fs.writeFileSync(file, body, "utf8");
		const renamed = path.join(path.dirname(file), `${path.basename(file, ".md")}-${slug(t)}.md`);
		fs.renameSync(file, renamed);
		file = renamed;
	} catch {
		/* keep the original name; a wrong filename beats losing the log */
	}
	return file;
}

/**
 * Append a markdown block to the session log. Returns the file path.
 *
 * The file already opens with `# <title>`, and the agent's first teaching
 * message almost always repeats it — so the first block's own top-level heading
 * is dropped rather than printing the title twice.
 */
export function append(markdown) {
	const fresh = !file;
	const f = ensureFile();
	let body = markdown.trimEnd();
	if (fresh) body = body.replace(/^#\s+[^\n]*\n*/, "");
	if (!body.trim()) return f;
	fs.appendFileSync(f, `${body}\n\n`, "utf8");
	return f;
}

export function currentFile() {
	return file;
}

export function currentName() {
	return file ? path.basename(file) : null;
}

/** Forget the current log so the next append starts a fresh file. */
export function startNew() {
	file = null;
	title = null;
}

const SAFE_NAME = /^[\w.\-À-ÿ]+\.md$/u;

/** Every saved session, newest first. */
export function list() {
	let names;
	try {
		names = fs.readdirSync(ROOT).filter((n) => n.endsWith(".md"));
	} catch {
		return [];
	}
	return names
		.map((name) => {
			const full = path.join(ROOT, name);
			const stat = fs.statSync(full);
			let heading = null;
			try {
				const head = fs.readFileSync(full, "utf8").slice(0, 400).split("\n");
				heading = head.find((l) => l.startsWith("# "))?.slice(2).trim() || null;
			} catch {
				/* unreadable — fall back to the filename */
			}
			return {
				name,
				title: heading || name.replace(/\.md$/, ""),
				mtime: stat.mtimeMs,
				size: stat.size,
				current: name === currentName(),
			};
		})
		.sort((a, b) => b.mtime - a.mtime);
}

/** Resolve a session filename to a path, refusing anything outside the folder. */
function resolveName(name) {
	if (!SAFE_NAME.test(name)) throw new Error("bad session name");
	const full = path.join(ROOT, name);
	if (path.dirname(full) !== path.resolve(ROOT)) throw new Error("bad session name");
	return full;
}

/** Read one saved session by filename. */
export function read(name) {
	return fs.readFileSync(resolveName(name), "utf8");
}

/** Delete one saved session. The live log can't be deleted out from under itself. */
export function remove(name) {
	if (name === currentName()) throw new Error("that is the live session — press `new` first");
	fs.unlinkSync(resolveName(name));
}
