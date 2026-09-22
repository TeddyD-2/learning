// ui.js — localhost HTTP server + SSE bridge between the MCP tools and the
// browser UI. Zero dependencies; everything is Node builtins.
//
// The MCP server (mcp.js) owns this process. When a tool needs the learner to
// answer something it calls openPrompt(), which pushes the prompt to every
// connected browser over SSE and returns a promise that resolves when one of
// them POSTs an answer back.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as sessionLog from "./log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");

/** Ports a learn server may be on: the preferred one, then the fallbacks. */
export const PORT_RANGE = 20;

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".json": "application/json; charset=utf-8",
};

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

/** Everything that has happened this session, replayed to late-joining tabs. */
let history = [];

/** Prompts still waiting on the learner, by id. */
const pending = new Map();

let nextId = 1;
let baseUrl = "";
let opened = false;
let liveModel = null;
/** "live" = attached to Claude Code over MCP; "browse" = the standalone reader. */
let mode = "live";

export function setMode(m) {
	mode = m;
}

function broadcast(event) {
	const payload = `data: ${JSON.stringify(event)}\n\n`;
	for (const res of clients) {
		try {
			res.write(payload);
		} catch {
			clients.delete(res);
		}
	}
}

/** Record an event in history AND push it to live clients. */
export function emit(event) {
	if (event.type === "meta" && event.model) liveModel = event.model;
	history.push(event);
	broadcast(event);
}

/**
 * Show a prompt in the browser and wait for the answer.
 * @param {object} prompt serialisable prompt descriptor ({kind, question, ...})
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} the raw answer payload the browser POSTed
 */
export function openPrompt(prompt, signal) {
	const id = `p${nextId++}`;
	const record = { ...prompt, id, kind: prompt.kind, answered: false };

	return new Promise((resolve, reject) => {
		pending.set(id, { record, resolve, reject });
		emit({ type: "prompt", prompt: record });
		ensureBrowser();

		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					if (!pending.has(id)) return;
					pending.delete(id);
					emit({ type: "prompt_cancelled", id });
					reject(new Error("cancelled"));
				},
				{ once: true },
			);
		}
	});
}

/** Mark a prompt resolved in the transcript (feedback the learner keeps seeing). */
export function closePrompt(id, resolution) {
	emit({ type: "prompt_resolved", id, resolution });
}

let lastSession = null;

/** Tell the page which file the lesson is being written to, when that changes. */
export function noteSession() {
	const name = sessionLog.currentName();
	if (name === lastSession) return;
	lastSession = name;
	emit({ type: "session", name });
}

function state() {
	return { mode, liveModel, currentSession: sessionLog.currentName() };
}

// ── http ────────────────────────────────────────────────────────────────────

function readBody(req) {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
			if (raw.length > 5e6) req.destroy();
		});
		req.on("end", () => {
			try {
				resolve(raw ? JSON.parse(raw) : {});
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

function json(res, body, status = 200) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

function serveStatic(req, res) {
	const urlPath = new URL(req.url, "http://localhost").pathname;
	const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
	const file = path.join(PUBLIC, rel);
	// Never escape the public dir.
	if (!file.startsWith(PUBLIC)) {
		res.writeHead(403).end("forbidden");
		return;
	}
	fs.readFile(file, (err, buf) => {
		if (err) {
			res.writeHead(404).end("not found");
			return;
		}
		res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
		res.end(buf);
	});
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");

	if (url.pathname === "/events") {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(`data: ${JSON.stringify({ type: "replay", events: history })}\n\n`);
		clients.add(res);
		const keepAlive = setInterval(() => {
			try {
				res.write(": ping\n\n");
			} catch {
				/* closed */
			}
		}, 20000);
		req.on("close", () => {
			clearInterval(keepAlive);
			clients.delete(res);
		});
		return;
	}

	if (url.pathname === "/answer" && req.method === "POST") {
		let body;
		try {
			body = await readBody(req);
		} catch {
			res.writeHead(400).end("bad json");
			return;
		}
		const entry = pending.get(body.id);
		if (!entry) {
			json(res, { ok: false, reason: "stale" }, 409);
			return;
		}
		pending.delete(body.id);
		json(res, { ok: true });
		entry.resolve(body);
		return;
	}

	// ── api ─────────────────────────────────────────────────────────────────

	if (url.pathname === "/api/state") {
		json(res, state());
		return;
	}

	// A live (MCP-attached) server asks the standalone reader to release the
	// port, so the learner keeps the same URL instead of silently ending up on
	// a browse-only page that no lesson can ever reach.
	if (url.pathname === "/api/yield" && req.method === "POST") {
		if (mode !== "browse") {
			json(res, { ok: false, reason: "live" }, 409);
			return;
		}
		json(res, { ok: true });
		setTimeout(() => {
			server.close();
			process.exit(0);
		}, 120);
		return;
	}

	if (url.pathname === "/api/sessions") {
		json(res, { sessions: sessionLog.list() });
		return;
	}

	if (url.pathname.startsWith("/api/session/")) {
		const name = decodeURIComponent(url.pathname.slice("/api/session/".length));
		try {
			if (req.method === "DELETE") {
				sessionLog.remove(name);
				json(res, { ok: true });
			} else {
				json(res, { name, markdown: sessionLog.read(name) });
			}
		} catch (err) {
			json(res, { ok: false, error: String(err.message) }, req.method === "DELETE" ? 400 : 404);
		}
		return;
	}

	if (url.pathname === "/api/new-session" && req.method === "POST") {
		// Clears the board and starts a fresh log file. The Claude Code
		// conversation is separate — the UI tells the learner to /clear there.
		for (const [id, entry] of pending) {
			entry.reject(new Error("session reset"));
			pending.delete(id);
		}
		history = [];
		sessionLog.startNew();
		liveModel = null;
		lastSession = null;
		broadcast({ type: "reset" });
		json(res, { ok: true });
		return;
	}

	serveStatic(req, res);
});

/**
 * Find a learn server already listening anywhere in the port range.
 * The preferred port isn't always the one in use — a second Claude Code session
 * lands on a fallback — so the standalone reader looks for the live one rather
 * than assuming 4242 and showing an empty page.
 */
export async function findRunning(preferred = defaultPort()) {
	let browseOnly = null;
	for (let port = preferred; port < preferred + PORT_RANGE; port++) {
		const url = `http://127.0.0.1:${port}`;
		const st = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(400) })
			.then((r) => (r.ok ? r.json() : null))
			.catch(() => null);
		if (!st || typeof st.mode !== "string") continue;
		if (st.mode === "live") return { url, mode: "live" };
		browseOnly ??= { url, mode: "browse" };
	}
	return browseOnly;
}

/** Ask a browse-only learn server on `port` to quit, so we can take the port. */
async function reclaimPort(port) {
	const probe = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(600) })
		.then((r) => (r.ok ? r.json() : null))
		.catch(() => null);
	if (probe?.mode !== "browse") return false;

	await fetch(`http://127.0.0.1:${port}/api/yield`, { method: "POST", signal: AbortSignal.timeout(600) }).catch(
		() => null,
	);
	// Wait for the socket to actually close before we try to bind it.
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 100));
		const alive = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(300) })
			.then(() => true)
			.catch(() => false);
		if (!alive) return true;
	}
	return false;
}

export function defaultPort() {
	return Number(process.env.LEARN_PORT) || 4242;
}

/** Start listening, trying a few ports if the preferred one is taken. */
export async function start(preferred = defaultPort()) {
	if (mode === "live") await reclaimPort(preferred);
	return new Promise((resolve) => {
		let port = preferred;
		const attempt = () => {
			server.once("error", (err) => {
				if (err.code === "EADDRINUSE" && port - preferred < PORT_RANGE) {
					port++;
					attempt();
				} else {
					throw err;
				}
			});
			server.listen(port, "127.0.0.1", () => {
				baseUrl = `http://127.0.0.1:${port}`;
				resolve(baseUrl);
			});
		};
		attempt();
	});
}

export function url() {
	return baseUrl;
}

/** Open the UI in the default browser, once per process. */
export function ensureBrowser() {
	if (opened || !baseUrl || process.env.LEARN_NO_OPEN) return;
	opened = true;
	openBrowser(baseUrl);
}

export function openBrowser(target) {
	if (process.env.LEARN_NO_OPEN) return;
	try {
		if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore" }).unref();
		} else if (process.platform === "darwin") {
			spawn("open", [target], { detached: true, stdio: "ignore" }).unref();
		} else {
			spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {
		/* the URL is printed on stderr anyway */
	}
}
