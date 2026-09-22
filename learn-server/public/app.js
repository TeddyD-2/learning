// app.js — renders the live session stream and the interactive prompts.
//
// Everything arrives over SSE from the MCP server. Answers go back over a
// plain POST. Markdown is rendered with marked, math with KaTeX and diagrams
// with mermaid, so a lesson can contain all three.

import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs";

mermaid.initialize({
	startOnLoad: false,
	theme: "dark",
	securityLevel: "loose",
	themeVariables: {
		fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
		fontSize: "14px",
		background: "#131a16",
		primaryColor: "#16241d",
		primaryTextColor: "#c8d6cd",
		primaryBorderColor: "#2b6f4c",
		lineColor: "#46d68a",
		secondaryColor: "#1b2a22",
		tertiaryColor: "#0f1512",
	},
});

marked.setOptions({ breaks: true, gfm: true });

const stream = document.getElementById("stream");
const dot = document.getElementById("status-dot");
const barRight = document.getElementById("bar-conn");
const barModel = document.getElementById("bar-model");
const hint = document.getElementById("hint");
const jumpBtn = document.getElementById("btn-jump");
const drawer = document.getElementById("drawer");
const scrim = document.getElementById("scrim");
const sessionList = document.getElementById("session-list");
const sessionFilter = document.getElementById("session-filter");
const barPath = document.getElementById("bar-path");
const archiveBar = document.getElementById("archive-bar");
const archiveName = document.getElementById("archive-name");

/** Non-null while reading a saved session instead of watching the live one. */
let viewingArchive = null;

/** "live" once /api/state confirms a Claude Code session is attached. */
let serverMode = "live";

/** Prompt id → live controller ({ el, focus(), answered }). */
const prompts = new Map();
let activePrompt = null;
let mermaidSeq = 0;

// ── rendering helpers ───────────────────────────────────────────────────────

const MATH_TOKEN = (i) => `@@KTX${i}@@`;

/**
 * Lift math spans out of the source before marked sees them. Markdown treats a
 * backslash before punctuation as an escape, so `$6\,\Omega$` reaches KaTeX as
 * `$6,\Omega$` — a literal comma in the output. Pulling the spans out and
 * putting them back after marked keeps the TeX byte-identical.
 * Code spans and fences are skipped so `$x$` inside `code` stays literal.
 */
function extractMath(src) {
	const math = [];
	let out = "";
	let i = 0;
	const take = (start, end) => {
		math.push(src.slice(start, end));
		out += MATH_TOKEN(math.length - 1);
		return end;
	};

	while (i < src.length) {
		if (src.startsWith("```", i)) {
			const end = src.indexOf("```", i + 3);
			const stop = end === -1 ? src.length : end + 3;
			out += src.slice(i, stop);
			i = stop;
		} else if (src[i] === "`") {
			const end = src.indexOf("`", i + 1);
			const stop = end === -1 ? src.length : end + 1;
			out += src.slice(i, stop);
			i = stop;
		} else if (src.startsWith("$$", i) && src.indexOf("$$", i + 2) !== -1) {
			i = take(i, src.indexOf("$$", i + 2) + 2);
		} else if (src.startsWith("\\[", i) && src.indexOf("\\]", i + 2) !== -1) {
			i = take(i, src.indexOf("\\]", i + 2) + 2);
		} else if (src.startsWith("\\(", i) && src.indexOf("\\)", i + 2) !== -1) {
			i = take(i, src.indexOf("\\)", i + 2) + 2);
		} else if (src[i] === "$" && src.indexOf("$", i + 1) > i + 1) {
			i = take(i, src.indexOf("$", i + 1) + 1);
		} else {
			out += src[i];
			i++;
		}
	}
	return { out, math };
}

/** Put the lifted math back into the rendered DOM, token by token. */
function restoreMath(host, math) {
	if (!math.length) return;
	const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
	const hits = [];
	while (walker.nextNode()) {
		if (walker.currentNode.nodeValue.includes("@@KTX")) hits.push(walker.currentNode);
	}
	for (const node of hits) {
		node.nodeValue = node.nodeValue.replace(/@@KTX(\d+)@@/g, (m, n) => math[Number(n)] ?? m);
	}
}

function renderMarkdown(md, host, inline = false) {
	// Pull mermaid fences out before marked so they never become <pre> blocks.
	const blocks = [];
	const withoutMermaid = md.replace(/```mermaid\s*\n([\s\S]*?)```/g, (_m, code) => {
		blocks.push(code);
		return `\n<div class="mermaid-host" data-mermaid="${blocks.length - 1}"></div>\n`;
	});

	const { out: src, math } = extractMath(withoutMermaid);
	host.innerHTML = inline ? marked.parseInline(src) : marked.parse(src);
	restoreMath(host, math);

	try {
		renderMathInElement(host, {
			delimiters: [
				{ left: "$$", right: "$$", display: true },
				{ left: "\\[", right: "\\]", display: true },
				{ left: "$", right: "$", display: false },
				{ left: "\\(", right: "\\)", display: false },
			],
			ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
			throwOnError: false,
		});
	} catch {
		/* KaTeX offline — plain text is still readable */
	}

	for (const slot of host.querySelectorAll("[data-mermaid]")) {
		const code = blocks[Number(slot.dataset.mermaid)];
		const id = `mmd-${mermaidSeq++}`;
		// A diagram lands after layout and changes the height under us, so
		// re-stick to the bottom only if that is where we already were.
		const wasAtBottom = atBottom();
		mermaid
			.render(id, code)
			.then(({ svg }) => {
				slot.innerHTML = svg;
				if (wasAtBottom) stickToBottom();
			})
			.catch((err) => {
				slot.innerHTML = `<pre class="md">mermaid error: ${escapeHtml(String(err?.message || err))}\n\n${escapeHtml(code)}</pre>`;
			});
	}
}

function escapeHtml(s) {
	return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function el(tag, cls, text) {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text !== undefined) n.textContent = text;
	return n;
}

function clearBoot() {
	const boot = stream.querySelector(".boot");
	if (boot) boot.remove();
}

function atBottom() {
	return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
}

function stickToBottom() {
	stream.scrollTop = stream.scrollHeight;
	updateJump();
}

function updateJump() {
	jumpBtn.hidden = atBottom();
}

function append(node) {
	const stick = atBottom();
	clearBoot();
	stream.appendChild(node);
	if (stick) stickToBottom();
	else updateJump();
}

// ── log blocks ──────────────────────────────────────────────────────────────

function addLog(markdown) {
	const block = el("div", "block");
	const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	block.appendChild(el("div", "block-head", `▚ lesson · ${time}`));
	const body = el("div", "md");
	renderMarkdown(markdown, body);
	block.appendChild(body);
	append(block);
}

// ── prompts ─────────────────────────────────────────────────────────────────

const DONT_KNOW = "__dont_know__";

function addPrompt(p) {
	const isQuiz = p.kind === "quiz";
	const wrap = el("div", "prompt");
	wrap.appendChild(el("div", "prompt-head", isQuiz ? "quiz" : "question"));

	const q = el("div", "prompt-q");
	renderMarkdown(p.question, q);
	wrap.appendChild(q);

	if (p.details) {
		const d = el("div", "prompt-details");
		renderMarkdown(p.details, d);
		wrap.appendChild(d);
	}

	const items = [...(p.options || [])];
	// "I don't know" is always last and always numbered, so every row on screen
	// has the number key that selects it.
	if (isQuiz) items.push({ label: "I don't know", value: DONT_KNOW, dontKnow: true });

	const selected = new Set();
	let cursor = 0;
	const rows = [];

	const list = el("ul", "opts");
	items.forEach((opt, i) => {
		const row = el("li", `opt${opt.dontKnow ? " dontknow" : ""}`);
		row.appendChild(el("span", "box", "[ ]"));
		row.appendChild(el("span", "num", `${i + 1}.`));
		const label = el("span", "label");
		const labelText = el("span", "label-text");
		renderMarkdown(opt.label, labelText, true);
		label.appendChild(labelText);
		if (opt.description) {
			const desc = el("span", "desc");
			renderMarkdown(opt.description, desc, true);
			label.appendChild(desc);
		}
		row.appendChild(label);
		row.addEventListener("click", () => {
			cursor = i;
			toggle(i);
		});
		list.appendChild(row);
		rows.push(row);
	});
	if (items.length) wrap.appendChild(list);

	// Free-text: the note field on a quiz, the answer field on an option-less ask.
	const freeText = !isQuiz && items.length === 0;
	const field = el("div", "field");
	field.appendChild(el("label", null, freeText ? "your answer" : isQuiz ? "note (optional)" : "other (optional)"));
	const textarea = document.createElement("textarea");
	textarea.rows = freeText ? 4 : 2;
	textarea.placeholder = freeText
		? "Type your answer…"
		: isQuiz
			? "What were you thinking? Reaches the teacher with your answer."
			: "Something not listed…";
	field.appendChild(textarea);
	wrap.appendChild(field);

	const actions = el("div", "actions");
	const submitBtn = el("button", "submit", "SUBMIT");
	submitBtn.type = "button";
	actions.appendChild(submitBtn);
	actions.appendChild(
		el(
			"span",
			"keys",
			items.length
				? "↑↓ move · space/1-9 select · enter submit · tab text"
				: "ctrl+enter submit",
		),
	);
	wrap.appendChild(actions);

	function refresh() {
		rows.forEach((row, i) => {
			const on = selected.has(i);
			row.classList.toggle("checked", on);
			row.classList.toggle("cursor", i === cursor && ctl.focused);
			row.querySelector(".box").textContent = on ? "[x]" : "[ ]";
		});
		submitBtn.disabled = items.length > 0 && selected.size === 0 && !textarea.value.trim();
	}

	function toggle(i) {
		const opt = items[i];
		const multi = p.multiSelect && !opt.dontKnow;
		if (selected.has(i)) {
			selected.delete(i);
		} else {
			if (!multi) selected.clear();
			// "I don't know" is exclusive; picking a real option clears it.
			if (opt.dontKnow) selected.clear();
			else for (const j of [...selected]) if (items[j].dontKnow) selected.delete(j);
			selected.add(i);
		}
		refresh();
	}

	async function submit() {
		if (ctl.answered) return;
		const values = [...selected].map((i) => items[i].value);
		const dontKnow = values.includes(DONT_KNOW);
		const text = textarea.value.trim();
		if (items.length > 0 && !values.length && !text) return;

		const payload = {
			id: p.id,
			values: values.filter((v) => v !== DONT_KNOW),
			dontKnow,
			note: isQuiz ? text : "",
			text: isQuiz ? "" : text,
		};
		ctl.answered = true;
		submitBtn.disabled = true;
		submitBtn.textContent = "SENT";
		textarea.disabled = true;
		const res = await fetch("/answer", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		}).catch(() => null);
		if (!res || !res.ok) {
			ctl.answered = false;
			submitBtn.disabled = false;
			submitBtn.textContent = "SUBMIT";
			textarea.disabled = false;
			hint.textContent = "answer rejected (session moved on) — try again";
		}
	}

	submitBtn.addEventListener("click", submit);
	textarea.addEventListener("input", refresh);
	textarea.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			submit();
		} else if (e.key === "Escape") {
			textarea.blur();
			refresh();
		}
	});

	const ctl = {
		el: wrap,
		items,
		rows,
		answered: false,
		focused: true,
		isQuiz,
		textarea,
		submit,
		key(e) {
			if (this.answered) return;
			if (document.activeElement === textarea) return;
			// keyCode fallbacks: some embedded/automated browsers send a blank e.key.
			const k = e.key || "";
			const is = (name, code) => k === name || (!k && e.keyCode === code);
			if (is("ArrowDown", 40) || (k === "j" && !e.ctrlKey)) {
				cursor = Math.min(items.length - 1, cursor + 1);
			} else if (is("ArrowUp", 38) || (k === "k" && !e.ctrlKey)) {
				cursor = Math.max(0, cursor - 1);
			} else if (is(" ", 32)) {
				toggle(cursor);
			} else if (is("Enter", 13)) {
				if (!selected.size && items.length) toggle(cursor);
				else submit();
			} else if (is("Tab", 9)) {
				textarea.focus();
			} else if (/^[1-9]$/.test(k) && Number(k) <= items.length) {
				const i = Number(k) - 1;
				cursor = i;
				toggle(i);
				if (!p.multiSelect && !items[i].dontKnow) refresh();
			} else {
				return;
			}
			e.preventDefault();
			refresh();
		},
	};

	prompts.set(p.id, ctl);
	activePrompt = ctl;
	hint.textContent = items.length
		? "↑↓ move · space or 1-9 select · enter submit · tab for the text field"
		: "type your answer · ctrl+enter to submit";
	refresh();
	append(wrap);
	if (freeText) textarea.focus();
	return ctl;
}

function resolvePrompt(id, r) {
	const ctl = prompts.get(id);
	if (!ctl) return;
	ctl.answered = true;
	ctl.focused = false;
	if (activePrompt === ctl) activePrompt = null;
	hint.textContent = "";

	ctl.el.classList.add("done");
	ctl.el.querySelector(".actions")?.remove();
	ctl.el.querySelector(".field")?.remove();

	if (ctl.isQuiz) {
		const picked = new Set(r.picked || []);
		const correct = new Set(r.correctValues || []);
		ctl.rows.forEach((row, i) => {
			const v = ctl.items[i].value;
			row.classList.remove("cursor");
			const mark = el("span", "mark", "");
			if (correct.has(v)) {
				row.classList.add("correct");
				mark.textContent = "✓";
			} else if (picked.has(v)) {
				row.classList.add("wrong");
				mark.textContent = "✗";
			}
			row.querySelector(".box").replaceWith(mark);
		});

		const verdict = el(
			"div",
			`verdict ${r.dontKnow ? "idk" : r.correct ? "ok" : "no"}`,
			r.dontKnow ? "◇ I don't know — noted as a gap, not a wrong answer" : r.correct ? "✓ Correct" : "✗ Incorrect",
		);
		ctl.el.appendChild(verdict);

		if (r.note) {
			const n = el("div", "explain");
			renderMarkdown(`**Your note:** ${r.note}`, n);
			ctl.el.appendChild(n);
		}
		if (r.explanation) {
			const ex = el("div", "explain");
			const body = el("div", "md");
			renderMarkdown(r.explanation, body);
			ex.appendChild(body);
			ctl.el.appendChild(ex);
		}
	} else {
		ctl.rows.forEach((row) => row.classList.remove("cursor"));
		// The summary is built from option labels, which may carry LaTeX.
		const a = el("div", "answered");
		renderMarkdown(`→ ${r.answer}`, a, true);
		ctl.el.appendChild(a);
	}

	if (atBottom()) stream.scrollTop = stream.scrollHeight;
}

function cancelPrompt(id) {
	const ctl = prompts.get(id);
	if (!ctl || ctl.answered) return;
	ctl.answered = true;
	if (activePrompt === ctl) activePrompt = null;
	ctl.el.classList.add("done");
	ctl.el.querySelector(".actions")?.remove();
	ctl.el.appendChild(el("div", "explain", "(cancelled)"));
}

// ── global keyboard ─────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
	if (!activePrompt || activePrompt.answered) return;
	activePrompt.key(e);
});

// ── event stream ────────────────────────────────────────────────────────────

function apply(ev) {
	if (ev.type === "meta") {
		// Self-reported by the teaching agent; the server cannot verify it.
		if (ev.model) barModel.textContent = `model: ${ev.model}`;
	} else if (ev.type === "session") {
		barPath.textContent = ev.name ? `sessions/${ev.name}` : "no session yet";
	} else if (ev.type === "log") addLog(ev.markdown);
	else if (ev.type === "prompt") addPrompt(ev.prompt);
	else if (ev.type === "prompt_resolved") resolvePrompt(ev.id, ev.resolution || {});
	else if (ev.type === "prompt_cancelled") cancelPrompt(ev.id);
}

/** Rebuild the live view from the server's history. */
function replay(events) {
	stream.innerHTML = "";
	barModel.textContent = "";
	barPath.textContent = "no session yet";
	prompts.clear();
	activePrompt = null;
	if (!events.length) {
		const msg =
			serverMode === "browse"
				? "Browse-only — no Claude Code session is attached, so no lesson can arrive here. Open Claude Code in this folder and ask to be taught something; past lessons are under <strong>sessions</strong>, top right."
				: "Ready. In Claude Code, run <code>/learn &lt;topic&gt;</code> — or just ask to be taught something — and the lesson appears here.";
		stream.innerHTML = `<div class="boot"><p class="muted">${msg}</p></div>`;
	}
	for (const e of events) apply(e);
	stickToBottom();
}

function connect() {
	const es = new EventSource("/events");

	es.onopen = async () => {
		dot.classList.add("live");
		dot.classList.remove("dead");
		// "connected" only means the page reached a server. Whether that server
		// is attached to Claude Code is a different question, and the one that
		// decides if a lesson can ever appear here.
		const st = await fetch("/api/state").then((r) => r.json()).catch(() => null);
		serverMode = st?.mode === "browse" ? "browse" : "live";
		if (serverMode === "browse") {
			barRight.textContent = "browse-only";
			barRight.title = "No Claude Code session is attached — open one in this folder to teach.";
			dot.classList.remove("live");
		} else {
			barRight.textContent = "connected";
			barRight.title = "";
		}
		// The replay usually lands before this fetch resolves, so redraw the empty
		// state now that we know whether anything can actually arrive.
		if (stream.querySelector(".boot")) replay(liveEvents);
	};

	es.onmessage = (msg) => {
		const ev = JSON.parse(msg.data);
		liveEvents = ev.type === "replay" ? [...ev.events] : [...liveEvents, ev];

		// While reading an archive, keep banking events but don't touch the view.
		if (viewingArchive) return;

		if (ev.type === "replay") {
			replay(ev.events);
		} else if (ev.type === "reset") {
			liveEvents = [];
			replay([]);
		} else {
			apply(ev);
		}
	};

	es.onerror = () => {
		dot.classList.remove("live");
		dot.classList.add("dead");
		barRight.textContent = "disconnected — retrying";
	};
}

// ── sessions drawer, archives, new session, model ───────────────────────────

/** Everything the live session has emitted, so we can restore it after an archive. */
let liveEvents = [];

function fmtWhen(ms) {
	const d = new Date(ms);
	const today = new Date();
	const sameDay = d.toDateString() === today.toDateString();
	const date = sameDay ? "today" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	return `${date} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function fmtSize(bytes) {
	return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/** The last /api/sessions response, so filtering doesn't re-fetch. */
let allSessions = [];

function renderSessions() {
	const q = sessionFilter.value.trim().toLowerCase();
	const shown = q ? allSessions.filter((s) => `${s.title} ${s.name}`.toLowerCase().includes(q)) : allSessions;

	sessionList.innerHTML = "";
	if (!shown.length) {
		sessionList.innerHTML = `<li class="empty">${
			allSessions.length ? "Nothing matches that." : "No saved lessons yet."
		}</li>`;
		return;
	}

	for (const s of shown) {
		const li = el("li", s.current ? "is-current" : "");
		const main = el("div", "s-main");
		main.appendChild(el("span", "s-title", s.current ? `${s.title} · live` : s.title));
		main.appendChild(el("span", "s-meta", `${fmtWhen(s.mtime)} · ${fmtSize(s.size)}`));
		main.addEventListener("click", () => showArchive(s));
		li.appendChild(main);

		const del = el("button", "s-del", "✕");
		del.type = "button";
		del.title = s.current ? "the live lesson can't be deleted — press `new` first" : `delete ${s.name}`;
		del.disabled = !!s.current;
		del.addEventListener("click", async (e) => {
			e.stopPropagation();
			if (!confirm(`Delete "${s.title}"? This removes sessions/${s.name} for good.`)) return;
			const res = await fetch(`/api/session/${encodeURIComponent(s.name)}`, { method: "DELETE" })
				.then((r) => r.json())
				.catch(() => null);
			if (res?.ok) {
				allSessions = allSessions.filter((x) => x.name !== s.name);
				renderSessions();
			} else {
				hint.textContent = `could not delete ${s.name}${res?.error ? ` — ${res.error}` : ""}`;
			}
		});
		li.appendChild(del);
		sessionList.appendChild(li);
	}
}

async function openDrawer() {
	drawer.hidden = false;
	scrim.hidden = false;
	sessionList.innerHTML = '<li class="empty">loading…</li>';
	const data = await fetch("/api/sessions").then((r) => r.json()).catch(() => ({ sessions: [] }));
	allSessions = data.sessions || [];
	renderSessions();
	sessionFilter.focus();
}

function closeDrawer() {
	drawer.hidden = true;
	scrim.hidden = true;
}

async function showArchive(session) {
	closeDrawer();
	const data = await fetch(`/api/session/${encodeURIComponent(session.name)}`)
		.then((r) => r.json())
		.catch(() => null);
	if (!data || data.error) {
		hint.textContent = `could not open ${session.name}`;
		return;
	}

	viewingArchive = session.name;
	activePrompt = null;
	archiveBar.hidden = false;
	archiveName.textContent = `reading ${session.name}`;
	stream.innerHTML = "";
	const block = el("div", "block");
	const body = el("div", "md");
	renderMarkdown(data.markdown, body);
	block.appendChild(body);
	stream.appendChild(block);
	stream.scrollTop = 0;
	hint.textContent = "archive — read only";
	updateJump();
}

function backToLive() {
	viewingArchive = null;
	archiveBar.hidden = true;
	hint.textContent = "";
	replay(liveEvents);
}

async function newSession() {
	await fetch("/api/new-session", { method: "POST" }).catch(() => null);
	viewingArchive = null;
	archiveBar.hidden = true;
	// The saved log is closed server-side; the next lesson opens a fresh file.
	hint.textContent = "cleared — run /clear in Claude Code, then ask for the next topic";
}

document.getElementById("btn-sessions").addEventListener("click", openDrawer);
document.getElementById("btn-close-drawer").addEventListener("click", closeDrawer);
document.getElementById("btn-new").addEventListener("click", newSession);
document.getElementById("btn-live").addEventListener("click", backToLive);
scrim.addEventListener("click", closeDrawer);
jumpBtn.addEventListener("click", stickToBottom);
stream.addEventListener("scroll", updateJump);
sessionFilter.addEventListener("input", renderSessions);

document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !drawer.hidden) {
		closeDrawer();
		e.preventDefault();
	}
});

connect();
