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
	const isFree = p.kind === "free";
	const wrap = el("div", `prompt${isFree ? " free" : ""}`);
	wrap.appendChild(el("div", "prompt-head", isQuiz ? "quiz" : isFree ? "free response" : "question"));

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
	textarea.rows = isFree ? 10 : freeText ? 4 : 2;
	textarea.placeholder = isFree
		? "Write it the way you would on the exam. Specific words from the text, specific details from the image."
		: freeText
		? "Type your answer…"
		: isQuiz
			? "What were you thinking? Reaches the teacher with your answer."
			: "Something not listed…";
	field.appendChild(textarea);
	// Free response: a live count against the target length, so the learner
	// practises the exam's sentence budget, not just the content.
	const counter = isFree ? el("div", "free-count") : null;
	if (counter) field.appendChild(counter);
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
		if (counter) {
			const text = textarea.value.trim();
			const words = text ? text.split(/\s+/).length : 0;
			const sentences = text.split(/[.!?]+(?=\s|$)/).filter((s) => s.trim().split(/\s+/).length >= 3).length;
			counter.textContent = `${sentences} sentence${sentences === 1 ? "" : "s"} · ${words} words${p.target ? ` · aim: ${p.target}` : ""}`;
		}
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
	if (ctl.isMatch) {
		ctl.resolve(r);
		return;
	}
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
	if (ctl.isMatch) ctl.cancel();
	ctl.answered = true;
	ctl.focused = false;
	if (activePrompt === ctl) activePrompt = null;
	hint.textContent = "";
	ctl.el.classList.add("done");
	ctl.el.querySelector(".actions")?.remove();
	ctl.el.querySelector(".field")?.remove();
	for (const row of ctl.rows || []) row.classList.remove("cursor");
	// Usually the old session ended before this was answered; resume tells
	// the teacher, who asks it again.
	ctl.el.appendChild(el("div", "explain", "(closed before it was answered; the teacher will ask it again)"));
}


// ── matching drill ──────────────────────────────────────────────────────────
//
// One card at a time: the prompt big, the answer bank right under it. A pick
// is graded on the spot. A wrong one is struck out and the card shakes, so a
// miss is impossible to overlook. "I don't know" shows the answer, and a note
// box lets the learner say what they were thinking. A card missed goes back to
// the end of the deck for a retest, so the drill only ends once every answer
// has been produced cleanly. Graded in the browser so feedback is instant; the
// full attempt history goes back to the server at the end.

const MATCH_KEYS = "1234567890abcdefghjklopqrstuvwxyz"; // no "i" (I don't know), "n" (note), "m" (map)

function addMatch(p) {
	const wrap = el("div", "prompt match");
	wrap.appendChild(el("div", "prompt-head", "drill · match"));
	const q = el("div", "prompt-q");
	renderMarkdown(p.question, q);
	wrap.appendChild(q);
	if (p.details) {
		const d = el("div", "prompt-details");
		renderMarkdown(p.details, d);
		wrap.appendChild(d);
	}

	const rows = new Map(p.rows.map((r) => [r.id, r]));
	/** rowId → { missed, revealed, dontKnow, done, dot } */
	const state = new Map();
	const attempts = {}; // rowId → [picked, picked, …]
	const notes = {}; // rowId → [note, …]
	const queue = p.rows.map((r) => r.id);
	let cur = null; // { id, retest, wrong: Set, settled }
	let seen = 0; // distinct cards shown so far

	// Status line: one dot per card, the score, a timer.
	const status = el("div", "match-status");
	const dots = el("div", "match-dots");
	const scoreEl = el("span", "match-score");
	const timerEl = el("span", "match-timer", "0:00");
	status.append(dots, scoreEl, timerEl);
	wrap.appendChild(status);
	for (const r of p.rows) {
		const dot = el("i", "match-dot");
		dot.title = `card ${state.size + 1}`;
		dots.appendChild(dot);
		state.set(r.id, { missed: false, revealed: false, dontKnow: false, done: false, dot });
	}
	const started = Date.now();
	const tick = setInterval(() => {
		const s = Math.floor((Date.now() - started) / 1000);
		timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
	}, 1000);

	// The card.
	const card = el("div", "match-card");
	const cardHead = el("div", "match-card-head");
	const prompt = el("div", "match-prompt");
	const bank = el("div", "match-bank");
	const feedback = el("div", "match-feedback");
	const tools = el("div", "match-tools");
	const idkBtn = el("button", "chip match-idk", "I don't know (i)");
	idkBtn.type = "button";
	const noteIn = el("input", "match-note");
	noteIn.type = "text";
	noteIn.placeholder = "note (n): what were you thinking? optional";
	tools.append(idkBtn, noteIn);
	const cardActions = el("div", "actions");
	const nextBtn = el("button", "submit", "NEXT ⏎");
	nextBtn.type = "button";
	cardActions.append(nextBtn);
	card.append(cardHead, prompt, bank, tools, feedback, cardActions);
	wrap.appendChild(card);

	const chips = new Map(); // value → button
	p.bank.forEach((value, i) => {
		const chip = el("button", "match-chip");
		chip.type = "button";
		const key = MATCH_KEYS[i];
		if (key) chip.appendChild(el("span", "chip-key", key));
		const text = el("span", "chip-text");
		renderMarkdown(value, text, true);
		chip.appendChild(text);
		chip.addEventListener("click", () => pick(value));
		bank.appendChild(chip);
		chips.set(value, chip);
	});

	idkBtn.addEventListener("click", dontKnow);
	noteIn.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === "Escape") {
			e.preventDefault();
			noteIn.blur();
			if (e.key === "Enter") next();
		}
	});
	nextBtn.addEventListener("click", next);

	function refresh() {
		const all = [...state.values()];
		const done = all.filter((s) => s.done).length;
		const clean = all.filter((s) => s.done && !s.missed).length;
		const missed = all.filter((s) => s.missed).length;
		scoreEl.textContent = `${clean} first try · ${missed} missed · ${p.rows.length - done} to go`;
		for (const [id, s] of state) {
			s.dot.className = `match-dot${s.done ? (s.missed ? " fixed" : " right") : s.missed ? " missed" : ""}${cur?.id === id ? " current" : ""}`;
		}
	}

	function show(id) {
		const r = rows.get(id);
		const st = state.get(id);
		cur = { id, retest: st.missed, wrong: new Set(), settled: false };
		if (!cur.retest) seen++;
		cardHead.textContent = cur.retest ? "retest · you missed this one earlier" : `card ${seen} of ${p.rows.length}`;
		cardHead.classList.toggle("retest", cur.retest);
		renderMarkdown(r.prompt, prompt);
		for (const chip of chips.values()) {
			chip.disabled = false;
			chip.classList.remove("wrong", "right", "answer");
		}
		feedback.innerHTML = "";
		feedback.className = "match-feedback";
		idkBtn.disabled = false;
		noteIn.value = "";
		nextBtn.hidden = true;
		card.classList.remove("ok", "no");
		hint.textContent = "pick an answer · click or press its key";
		refresh();
		if (card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: "start" });
	}

	function verdict(cls, text) {
		feedback.innerHTML = "";
		feedback.appendChild(el("div", `verdict ${cls}`, text));
	}

	function explain(r) {
		if (!r.explanation) return;
		const why = el("div", "explain");
		renderMarkdown(r.explanation, why);
		feedback.appendChild(why);
	}

	function pick(value) {
		if (!cur || cur.settled || cur.wrong.has(value)) return;
		const r = rows.get(cur.id);
		const st = state.get(cur.id);
		(attempts[cur.id] ||= []).push(value);
		const chip = chips.get(value);

		if (value === r.answer) {
			cur.settled = true;
			chip.classList.add("right");
			for (const c of chips.values()) c.disabled = true;
			card.classList.remove("no");
			card.classList.add("ok");
			if (cur.wrong.size) {
				verdict("ok", `✓ ${r.answer}. Got it on try ${cur.wrong.size + 1}; it comes back at the end for a retest.`);
				queue.push(cur.id);
			} else {
				st.done = true;
				verdict("ok", cur.retest ? `✓ ${r.answer}. Fixed on the retest.` : `✓ ${r.answer}`);
			}
			explain(r);
			settle();
			return;
		}

		// Wrong: strike the chip out, shake the card, say so plainly.
		st.missed = true;
		cur.wrong.add(value);
		chip.classList.add("wrong");
		chip.disabled = true;
		card.classList.remove("no");
		void card.offsetWidth; // restart the shake
		card.classList.add("no");
		verdict("no", `✗ Not “${value}”. Try again, or press “I don't know”.`);
		refresh();
	}

	function dontKnow() {
		if (!cur || cur.settled) return;
		const r = rows.get(cur.id);
		const st = state.get(cur.id);
		st.missed = true;
		st.revealed = true;
		st.dontKnow = true;
		cur.settled = true;
		for (const c of chips.values()) c.disabled = true;
		chips.get(r.answer)?.classList.add("answer");
		verdict("idk", `? The answer is “${r.answer}”. It comes back at the end for a retest.`);
		explain(r);
		queue.push(cur.id);
		settle();
	}

	function settle() {
		idkBtn.disabled = true;
		nextBtn.hidden = false;
		nextBtn.textContent = queue.length ? "NEXT ⏎" : "FINISH ⏎";
		hint.textContent = "enter for the next card";
		refresh();
	}

	function next() {
		if (!cur?.settled) return;
		const note = noteIn.value.trim();
		if (note) (notes[cur.id] ||= []).push(note);
		if (queue.length) show(queue.shift());
		else finish();
	}

	function summary(results) {
		card.remove();
		const clean = results.filter((x) => x.firstTry).length;
		wrap.appendChild(el("div", `verdict ${clean === results.length ? "ok" : "idk"}`, `◆ ${clean}/${results.length} on the first try`));
		const board = el("div", "match-summary");
		// Misses first: they are what to study next.
		for (const x of [...results].sort((a, b) => a.firstTry - b.firstTry)) {
			const row = el("div", `match-sum-row ${x.firstTry ? "right" : "missed"}`);
			const mark = el("span", "match-sum-mark", x.firstTry ? "✓" : x.dontKnow ? "?" : x.revealed ? "◆" : "✗");
			const pr = el("div", "match-prompt");
			renderMarkdown(x.prompt, pr, true);
			const ans = el("div", "match-sum-answer");
			renderMarkdown(x.answer, ans, true);
			const wrongs = (x.tries || []).filter((t) => t !== x.answer);
			if (wrongs.length) ans.appendChild(el("div", "match-sum-tried", `you tried: ${[...new Set(wrongs)].join(", ")}`));
			if (x.notes?.length) ans.appendChild(el("div", "match-sum-note", `your note: ${x.notes.join(" · ")}`));
			row.append(mark, pr, ans);
			board.appendChild(row);
		}
		wrap.appendChild(board);
	}

	async function finish() {
		ctl.answered = true;
		clearInterval(tick);
		cur = null;
		refresh();
		hint.textContent = "";
		const revealed = [...state].filter(([, s]) => s.revealed).map(([id]) => id);
		const idk = [...state].filter(([, s]) => s.dontKnow).map(([id]) => id);
		summary(
			p.rows.map((r) => {
				const tries = attempts[r.id] || [];
				const rev = revealed.includes(r.id);
				return { ...r, tries, revealed: rev, dontKnow: idk.includes(r.id), notes: notes[r.id] || [], firstTry: tries[0] === r.answer && !rev };
			}),
		);
		wrap.classList.add("done");
		const res = await fetch("/answer", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: p.id, attempts, revealed, dontKnow: idk, notes }),
		}).catch(() => null);
		if (!res || !res.ok) hint.textContent = "drill result rejected (session moved on)";
	}

	const ctl = {
		el: wrap,
		isMatch: true,
		answered: false,
		key(e) {
			if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, textarea")) return;
			if (e.key === "Enter") {
				e.preventDefault();
				next();
				return;
			}
			const k = e.key.toLowerCase();
			if (k === "i" && cur && !cur.settled) {
				e.preventDefault();
				dontKnow();
				return;
			}
			if (k === "n" && cur) {
				e.preventDefault();
				noteIn.focus();
				return;
			}
			const i = MATCH_KEYS.indexOf(k);
			if (i >= 0 && i < p.bank.length) {
				e.preventDefault();
				pick(p.bank[i]);
			}
		},
		cancel() {
			clearInterval(tick);
			cur = null;
			card.remove();
			wrap.classList.add("done");
		},
		resolve(r) {
			// Live: finish() already drew the summary. Replay: draw it from the
			// server's record, since nothing was played in this page.
			clearInterval(tick);
			if (!wrap.classList.contains("done")) {
				ctl.answered = true;
				cur = null;
				for (const x of r.results || []) {
					const s = state.get(x.id);
					if (s) Object.assign(s, { done: true, missed: !x.firstTry });
				}
				refresh();
				summary(r.results || []);
				wrap.classList.add("done");
			}
			if (activePrompt === ctl) activePrompt = null;
			hint.textContent = "";
		},
	};

	prompts.set(p.id, ctl);
	activePrompt = ctl;
	append(wrap);
	show(queue.shift());
	return ctl;
}

// ── progress map ────────────────────────────────────────────────────────────

const mapEl = document.getElementById("map");
const mapBody = document.getElementById("map-body");

const mapPill = document.getElementById("btn-map");
const mapPillStats = document.getElementById("map-pill-stats");
/** Wide screens dock the map beside the lesson; narrow ones open it over it. */
const narrowMap = window.matchMedia("(max-width: 1000px)");

function renderMap(map) {
	if (!map || !map.nodes?.length) {
		mapEl.hidden = true;
		mapPill.hidden = true;
		document.body.classList.remove("has-map", "map-open");
		return;
	}
	mapEl.hidden = false;
	mapPill.hidden = false;
	document.body.classList.add("has-map");
	document.getElementById("map-title").textContent = map.title || "map";

	const n = map.nodes.length;
	const count = (s) => map.nodes.filter((x) => x.status === s).length;
	// Solid counts fully, shaky/learning partly — the bar is "how much is held".
	const pct = Math.round(((count("solid") + 0.5 * count("shaky") + 0.25 * count("learning")) / n) * 100);
	document.getElementById("map-fill").style.width = `${pct}%`;
	document.getElementById("map-stats").textContent = `${pct}% · ${count("solid")}/${n} solid · ${count("shaky")} shaky`;
	mapPillStats.textContent = `${count("solid")}/${n}`;

	mapBody.innerHTML = "";
	let group = null;
	let list = null;
	for (const node of map.nodes) {
		if (!list || (node.group || "") !== group) {
			group = node.group || "";
			if (group) mapBody.appendChild(el("div", "map-group", group));
			list = el("ul", "map-list");
			mapBody.appendChild(list);
		}
		const li = el("li", `map-node ${node.status}${node.id === map.current ? " current" : ""}`);
		li.title = `${node.label} · ${node.status}`;
		li.appendChild(el("i", `st ${node.status}`));
		const label = el("span", "map-label");
		renderMarkdown(node.label, label, true);
		li.appendChild(label);
		list.appendChild(li);
	}
	mapBody.querySelector(".current")?.scrollIntoView({ block: "nearest" });
}

// Wide: the map is docked and the choice to hide it is remembered. Narrow:
// it is always closed until opened, and closes on a click outside or Esc.
function mapHiddenPref() {
	try {
		return localStorage.getItem("learn.mapHidden") === "1";
	} catch {
		return false;
	}
}

function setMapHidden(hidden) {
	document.body.classList.toggle("map-hidden", hidden);
	try {
		localStorage.setItem("learn.mapHidden", hidden ? "1" : "0");
	} catch {
		/* storage blocked: the choice just won't persist */
	}
}

function toggleMap() {
	if (narrowMap.matches) document.body.classList.toggle("map-open");
	else setMapHidden(!document.body.classList.contains("map-hidden"));
}

document.body.classList.toggle("map-hidden", mapHiddenPref());
mapPill.addEventListener("click", toggleMap);
document.getElementById("btn-map-toggle").addEventListener("click", () => {
	if (narrowMap.matches) document.body.classList.remove("map-open");
	else setMapHidden(true);
});
narrowMap.addEventListener("change", () => document.body.classList.remove("map-open"));
document.addEventListener("click", (e) => {
	if (document.body.classList.contains("map-open") && !e.target.closest("#map, #btn-map")) {
		document.body.classList.remove("map-open");
	}
}, true); // capture: image clicks stop propagation before it bubbles here
document.addEventListener("keydown", (e) => {
	if (e.target.closest?.("input, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
	if (e.key === "Escape" && document.body.classList.contains("map-open")) document.body.classList.remove("map-open");
	else if (e.key === "m" && !mapPill.hidden) toggleMap();
});

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
	else if (ev.type === "prompt") ev.prompt.kind === "match" ? addMatch(ev.prompt) : addPrompt(ev.prompt);
	else if (ev.type === "progress") renderMap(ev.map);
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
	renderMap(null);
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

// ── image lightbox ──────────────────────────────────────────────────────────

stream.addEventListener("click", (e) => {
	const img = e.target.closest(".md img, .match-prompt img");
	if (!img) return;
	e.stopPropagation();
	const box = el("div", "lightbox");
	const big = document.createElement("img");
	big.src = img.src;
	big.alt = img.alt;
	box.appendChild(big);
	box.addEventListener("click", () => box.remove());
	document.body.appendChild(box);
});

document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") document.querySelector(".lightbox")?.remove();
});
