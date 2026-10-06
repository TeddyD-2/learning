#!/usr/bin/env node
// mcp.js — MCP stdio server exposing the learning tools to Claude Code.
//
// Tools:
//   quiz               graded multiple-choice, instantly marked in the browser
//   ask_user_question  ungraded preference/decision question
//   log                mirror a teaching message into the session markdown log
//   match              graded matching drill, one card at a time
//   progress           the sidebar map of every node and how well it's held
//   free_response      the learner writes an answer; the agent grades it
//   sessions / resume  list saved lessons and pick one back up, map and all
//
// Hand-rolled JSON-RPC over newline-delimited stdin/stdout so the whole thing
// installs with zero npm dependencies.

import readline from "node:readline";
import * as ui from "./ui.js";
import * as sessionLog from "./log.js";

const PROTOCOL_VERSION = "2024-11-05";

// ── tool schemas ────────────────────────────────────────────────────────────

const optionSchema = {
	type: "object",
	properties: {
		label: { type: "string", description: "The option text the learner reads." },
		value: { type: "string", description: "Stable id for the option; correctAnswer references this." },
		description: { type: "string", description: "Optional one-line clarification under the label." },
	},
	required: ["label", "value"],
	additionalProperties: false,
};

const TOOLS = [
	{
		name: "quiz",
		description:
			"Ask the learner a GRADED question with a known correct answer, then instantly grade it and show feedback (right/wrong, the correct answer, your explanation) in the terminal UI. Unlike ask_user_question (preferences, no right answer), quiz always has a correct answer you supply. Use it to (1) map what the learner already understands before teaching and (2) confirm each node landed after teaching it. Options-only, single- or multi-select, plus an automatic \"I don't know\" choice so an honest gap is distinguishable from a guess, and an optional free-text note the learner can attach to any answer. Blocks until they answer. The question, the options, what they picked and your explanation are written to the session log file automatically — don't re-log a quiz with the `log` tool.",
		inputSchema: {
			type: "object",
			properties: {
				question: { type: "string", description: "The single quiz question. Exactly one question per call." },
				details: { type: "string", description: "Optional extra context shown under the question." },
				options: {
					type: "array",
					items: optionSchema,
					minItems: 2,
					description:
						"The answer options (2+). Options only — no free-text mode. Never add your own 'I don't know' option; one is always added for you.",
				},
				multiSelect: { type: "boolean", description: "True only when more than one option is correct." },
				correctAnswer: {
					anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
					description:
						"REQUIRED. The correct option value(s) — the `value` field, never a position number. Multi-select is graded as an exact set match.",
				},
				explanation: {
					type: "string",
					description: "REQUIRED. Revealed after they answer, right or wrong. Say why the correct answer is correct.",
				},
				shuffle: {
					type: "boolean",
					description:
						"Defaults true. Set false only when option order is meaningful (ordered values, 'all of the above').",
				},
			},
			required: ["question", "options", "correctAnswer", "explanation"],
			additionalProperties: false,
		},
	},
	{
		name: "ask_user_question",
		description:
			"Ask the learner a single UNGRADED question and pause until they answer — preferences, direction, what they want next, anything with no right answer. Options are optional: with them the learner also gets an 'Other' free-text choice; without them it is a plain free-text prompt. If the question has a correct answer, use quiz instead. The question and their answer are written to the session log automatically.",
		inputSchema: {
			type: "object",
			properties: {
				question: { type: "string", description: "The single question. Exactly one question per call." },
				details: { type: "string", description: "Optional extra context shown under the question." },
				options: {
					type: "array",
					items: optionSchema,
					description:
						"Optional choices. Omit for a free-text answer. 'Other' is always available when options are given.",
				},
				multiSelect: { type: "boolean", description: "Allow selecting several answers." },
			},
			required: ["question"],
			additionalProperties: false,
		},
	},
	{
		name: "log",
		description:
			"Mirror a teaching message into the session log. The markdown is appended to a .md file AND rendered live in the terminal UI with LaTeX ($...$, $$...$$), ```mermaid``` diagrams and inline SVG. Call this with the same markdown you just sent in chat, every time you teach something — the log is what the learner keeps and re-reads. Pass `title` and `model` on the first call of a session.",
		inputSchema: {
			type: "object",
			properties: {
				markdown: { type: "string", description: "The markdown block to append and render." },
				title: { type: "string", description: "Session title. Only takes effect on the first log call." },
				model: {
					type: "string",
					description:
						"The model you are running as (e.g. 'Opus 5', 'Sonnet 5'), shown in the UI header so the learner can see who is teaching. Pass it on your first log call of a session. State it honestly; if you are not certain which model you are, omit this rather than guessing.",
				},
			},
			required: ["markdown"],
			additionalProperties: false,
		},
	},
	{
		name: "match",
		description:
			"A GRADED matching drill, one card at a time: each prompt is shown large with the shared answer bank under it, and every pick is graded instantly. A wrong pick is struck out and the learner tries again; an 'I don't know' button shows the answer, and a note box lets them say what they were thinking (both come back in the result). Missed or revealed cards come back at the end of the deck for a retest, so the drill ends only once every answer has been produced cleanly. Use it for 'cover the right column and test yourself' review — image→concept, term→definition, author→work. Answers may repeat (two prompts can share one answer); the chip bank lists each distinct answer once and chips are reusable. Add `distractors` for answers that match nothing. Each pair may carry a `node` id from the progress map: first-try correct marks that node solid, a miss marks it shaky. Blocks until finished; results are logged automatically.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string", description: "Short drill title." },
				instructions: { type: "string", description: "Optional one-line instruction under the title." },
				pairs: {
					type: "array",
					minItems: 2,
					items: {
						type: "object",
						properties: {
							prompt: { type: "string", description: "Left side — the thing to identify." },
							answer: { type: "string", description: "Right side — the correct match. Identical strings are one chip." },
							explanation: { type: "string", description: "Optional: shown when this row is revealed or after a miss." },
							node: { type: "string", description: "Optional progress-map node id this row tests." },
						},
						required: ["prompt", "answer"],
						additionalProperties: false,
					},
				},
				distractors: {
					type: "array",
					items: { type: "string" },
					description: "Optional extra answer chips that match no prompt.",
				},
			},
			required: ["title", "pairs"],
			additionalProperties: false,
		},
	},
	{
		name: "progress",
		description:
			"Set or update the progress map — a sidebar showing every node of the full material and how well the learner holds each one, so they always see where they are relative to the whole. First call: pass every node (status 'todo'). Later calls: pass only the nodes that changed (merged by id), and `current` for the node being taught now. Statuses: todo · learning · shaky · solid. `match` updates statuses on its own for pairs that carry a node id. Non-blocking.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string", description: "Name of the whole map (e.g. 'Exam 1 — 16 slides')." },
				nodes: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							label: { type: "string" },
							group: { type: "string", description: "Optional section heading the node sits under." },
							status: { type: "string", enum: ["todo", "learning", "shaky", "solid"] },
						},
						required: ["id"],
						additionalProperties: false,
					},
				},
				current: { type: "string", description: "Id of the node being taught now; highlighted in the map." },
				reset: { type: "boolean", description: "Replace the whole map instead of merging." },
			},
			additionalProperties: false,
		},
	},
	{
		name: "free_response",
		description:
			"A free-response question: the learner writes an answer in their own words (a large text box with a live sentence/word count against `target`). Use it after the overview and the quick quiz checks on a topic, to make the learner produce the knowledge instead of recognizing it, e.g. an exam-style paragraph. Blocks until they submit, then returns their text. YOU grade it: right after, call `log` with specific feedback (what was right, what was missing or wrong, quoting their words, and what a full-credit answer adds), and update the progress map.",
		inputSchema: {
			type: "object",
			properties: {
				question: { type: "string", description: "The prompt, in markdown. Images allowed via ![alt](/files/…)." },
				details: { type: "string", description: "Optional extra context or instructions shown under the question." },
				target: { type: "string", description: "Optional target length shown beside the live count, e.g. '4–5 sentences'." },
			},
			required: ["question"],
			additionalProperties: false,
		},
	},
	{
		name: "sessions",
		description:
			"List the saved lessons in sessions/, newest first: file name, title, last activity, and whether it can be fully resumed (sessions saved with their event history restore the progress map and every quiz/drill; older ones restore the log text only). Call this when the learner wants to continue an earlier lesson, then call `resume`.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "resume",
		description:
			"Continue a saved lesson where it left off. The UI redraws its whole history (log, quizzes with their answers, drills, the progress map), new blocks append to the same session file, and you get back a summary: the map with every node's status, the graded results so far, any question that was still unanswered when the old session ended (ask it again), and the last log blocks so you know exactly where the teaching stopped. Defaults to the most recent saved session.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Session file name from `sessions` (e.g. '2026-10-04-2122-greek-myth-exam-1-full-review.md'). Omit for the most recent." },
			},
			additionalProperties: false,
		},
	},
];

// ── quiz helpers ────────────────────────────────────────────────────────────

function normalizeOptions(raw) {
	const seen = new Set();
	return (raw || []).map((o, i) => {
		const label = String(o?.label ?? "").trim();
		let value = String(o?.value ?? label).trim() || `option-${i + 1}`;
		if (seen.has(value)) value = `${value}-${i + 1}`;
		seen.add(value);
		return { label, value, description: o?.description?.trim() || undefined };
	});
}

function shuffled(arr) {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

function setsEqual(a, b) {
	return a.length === b.length && a.every((x) => b.includes(x));
}

// ── tool implementations ────────────────────────────────────────────────────

async function runQuiz(args) {
	const explanation = String(args.explanation || "").trim();
	const multiSelect = args.multiSelect === true;
	let options = normalizeOptions(args.options);
	if (options.length < 2) throw new Error("quiz requires at least two options");
	if (args.shuffle !== false) options = shuffled(options);

	const correct = Array.isArray(args.correctAnswer) ? args.correctAnswer.map(String) : [String(args.correctAnswer)];
	const known = new Set(options.map((o) => o.value));
	const unknown = correct.filter((v) => !known.has(v));
	if (unknown.length) {
		throw new Error(
			`correctAnswer ${unknown.map((v) => `"${v}"`).join(", ")} matches no option value. Valid values: ${[...known].join(", ")}`,
		);
	}

	const answer = await ui.openPrompt({
		kind: "quiz",
		question: args.question,
		details: args.details,
		options,
		multiSelect,
	});

	const dontKnow = answer.dontKnow === true;
	const picked = dontKnow ? [] : (answer.values || []).filter((v) => known.has(v));
	const isCorrect = !dontKnow && setsEqual(picked, correct);
	const note = (answer.note || "").trim();

	ui.closePrompt(answer.id, { correct: isCorrect, dontKnow, picked, correctValues: correct, explanation, note });

	const label = (v) => options.find((o) => o.value === v)?.label ?? v;
	const verdict = dontKnow ? "I DON'T KNOW (honest gap, not a guess)" : isCorrect ? "CORRECT" : "INCORRECT";

	// The saved log has to be a faithful transcript. Quizzes carry most of a
	// probe phase, so a file without them reads as an empty session.
	const mark = (v) => {
		const isKey = correct.includes(v);
		const chosen = picked.includes(v);
		if (isKey && chosen) return "- [x] ";
		if (isKey) return "- [ ] ";
		if (chosen) return "- [x] ";
		return "- [ ] ";
	};
	const suffix = (v) => {
		const isKey = correct.includes(v);
		const chosen = picked.includes(v);
		if (isKey) return " ✓";
		return chosen ? " ✗" : "";
	};
	const block = [
		`### Quiz — ${dontKnow ? "didn't know" : isCorrect ? "correct" : "incorrect"}`,
		"",
		`**${args.question}**`,
		...(args.details ? ["", args.details] : []),
		"",
		...options.map((o) => `${mark(o.value)}${o.label}${suffix(o.value)}`),
		...(dontKnow ? ["- [x] I don't know"] : []),
		...(note ? ["", `**Note:** ${note}`] : []),
		...(explanation ? ["", `**Why:** ${explanation}`] : []),
	].join("\n");
	sessionLog.append(block);
	ui.noteSession();
	const lines = [
		`Question: ${args.question}`,
		`Result: ${verdict}`,
		`Learner picked: ${picked.length ? picked.map(label).join(" | ") : "—"}`,
		`Correct answer: ${correct.map(label).join(" | ")}`,
	];
	if (note) lines.push(`Learner's note: ${note}`);
	return lines.join("\n");
}

async function runAsk(args) {
	const options = normalizeOptions(args.options);
	const answer = await ui.openPrompt({
		kind: "ask",
		question: args.question,
		details: args.details,
		options,
		multiSelect: args.multiSelect === true,
	});

	const chosen = answer.values || [];
	const text = (answer.text || "").trim();
	const labels = chosen.map((v) => options.find((o) => o.value === v)?.label ?? v);
	const parts = [...labels];
	if (text) parts.push(options.length ? `Other: ${text}` : text);
	const summary = parts.length ? parts.join(" | ") : "(no answer)";

	sessionLog.append(
		[
			"### Question",
			"",
			`**${args.question}**`,
			...(args.details ? ["", args.details] : []),
			"",
			`**Answer:** ${summary}`,
		].join("\n"),
	);

	ui.noteSession();
	ui.closePrompt(answer.id, { answer: summary });
	return `Question: ${args.question}\nLearner answered: ${summary}`;
}

// ── progress map ────────────────────────────────────────────────────────────

const STATUSES = new Set(["todo", "learning", "shaky", "solid"]);
const progressMap = { title: "", nodes: [], current: null };

function applyProgress(args) {
	if (args.reset) {
		progressMap.nodes = [];
		progressMap.current = null;
	}
	if (args.title) progressMap.title = args.title;
	for (const n of args.nodes || []) {
		const id = String(n.id);
		let node = progressMap.nodes.find((x) => x.id === id);
		if (!node) {
			node = { id, label: id, group: "", status: "todo" };
			progressMap.nodes.push(node);
		}
		if (n.label) node.label = n.label;
		if (n.group !== undefined) node.group = n.group;
		if (STATUSES.has(n.status)) node.status = n.status;
	}
	if (args.current !== undefined) progressMap.current = args.current || null;
	ui.emit({ type: "progress", map: structuredClone(progressMap) });
}

function progressSummary() {
	const count = (s) => progressMap.nodes.filter((n) => n.status === s).length;
	return `Map: ${count("solid")} solid · ${count("shaky")} shaky · ${count("learning")} learning · ${count("todo")} todo (of ${progressMap.nodes.length})`;
}

function runProgress(args) {
	applyProgress(args);
	ui.ensureBrowser();
	return progressSummary();
}

// ── free response ───────────────────────────────────────────────────────────

async function runFreeResponse(args) {
	const answer = await ui.openPrompt({
		kind: "free",
		question: String(args.question),
		details: args.details,
		target: args.target,
		options: [],
	});
	const text = String(answer.text || "").trim();
	ui.closePrompt(answer.id, { answer: text || "(no answer)" });
	sessionLog.append(
		["### Free response", "", `**${args.question}**`, ...(args.details ? ["", args.details] : []), "", text ? text.replace(/^/gm, "> ") : "> (no answer)"].join("\n"),
	);
	ui.noteSession();
	return [
		`Free response: ${args.question}`,
		args.target ? `Target length: ${args.target}` : null,
		"Learner's answer:",
		text || "(no answer)",
		"",
		"Grade it now with `log`: what was right, what was missing or wrong (quote their words), and what a full-credit answer adds. Then update the progress map.",
	]
		.filter((l) => l !== null)
		.join("\n");
}

// ── saved sessions ──────────────────────────────────────────────────────────

/** Point the agent at the most recent lesson when it connects. */
function latestSessionHint() {
	const last = sessionLog.list()[0];
	if (!last) return "";
	return ` The most recent saved lesson is "${last.title}" (${last.name}), last active ${new Date(last.mtime).toLocaleString()}.`;
}

function runSessions() {
	const all = sessionLog.list();
	if (!all.length) return "No saved sessions yet.";
	return all
		.slice(0, 25)
		.map(
			(s) =>
				`- ${s.name} — "${s.title}" · last activity ${new Date(s.mtime).toLocaleString()}` +
				`${s.resumable ? "" : " · log text only (saved before full history was kept)"}${s.current ? " · live now" : ""}`,
		)
		.join("\n");
}

/** One line of plain text from prompt markdown: images dropped, whitespace collapsed. */
function plain(md, max = 140) {
	const s = String(md || "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function runResume(args) {
	const all = sessionLog.list();
	const target = args.name ? all.find((s) => s.name === args.name) : all.find((s) => !s.current);
	if (!target) throw new Error(args.name ? `no saved session named ${args.name} (see \`sessions\`)` : "no saved session to resume");

	let events = sessionLog.readEvents(target.name);
	sessionLog.adopt(target.name);
	const legacy = !events.length;
	if (legacy) {
		// Saved before events were kept: show the log text, and save it as an
		// event so the next resume of this session is complete.
		const body = sessionLog.read(target.name).replace(/^# .*\n+(_[^\n]*_\n+)?/, "");
		events = [{ type: "log", markdown: body }];
		sessionLog.appendEvent(events[0]);
	}

	const lastMap = [...events].reverse().find((e) => e.type === "progress")?.map;
	progressMap.title = lastMap?.title || "";
	progressMap.nodes = lastMap?.nodes ? structuredClone(lastMap.nodes) : [];
	progressMap.current = lastMap?.current ?? null;

	const stale = ui.restore(events);
	ui.ensureBrowser();

	const lines = [`Resumed "${target.title}" (${target.name}). The learner's page now shows its full history at ${ui.url()}; new blocks append to the same file.`];

	if (progressMap.nodes.length) {
		lines.push("", `Progress map "${progressMap.title}": ${progressSummary()}`);
		for (const n of progressMap.nodes) {
			lines.push(`- [${n.status}] ${plain(n.label, 80)} (${n.id})${n.id === progressMap.current ? " ← current" : ""}`);
		}
	} else {
		lines.push("", "No progress map was set in this session.");
	}

	const prompts = new Map(events.filter((e) => e.type === "prompt").map((e) => [e.prompt.id, e.prompt]));
	const graded = [];
	for (const e of events) {
		if (e.type !== "prompt_resolved") continue;
		const p = prompts.get(e.id);
		const r = e.resolution || {};
		if (!p) continue;
		if (p.kind === "match") {
			const missed = (r.results || []).filter((x) => !x.firstTry).map((x) => `${plain(x.prompt, 50)} → ${x.answer}`);
			graded.push(`- drill "${plain(p.question, 60)}": ${r.first}/${r.total} first try${missed.length ? `; missed: ${missed.join("; ")}` : ""}`);
		} else if (p.kind === "ask") {
			graded.push(`- asked: ${plain(p.question)} → ${plain(r.answer, 100)}`);
		} else if (p.kind === "free") {
			graded.push(`- free response: ${plain(p.question)} → "${plain(r.answer, 160)}"`);
		} else {
			graded.push(`- ${r.dontKnow ? "? didn't know" : r.correct ? "✓" : "✗"} ${plain(p.question)}${r.note ? ` (note: ${plain(r.note, 80)})` : ""}`);
		}
	}
	if (graded.length) lines.push("", "Questions and drills so far (oldest first):", ...graded.slice(-30));

	if (stale.length) {
		lines.push("", "Still unanswered when the last session ended (closed now; ask again if still relevant):");
		for (const id of stale) lines.push(`- ${prompts.get(id)?.kind || "question"}: ${plain(prompts.get(id)?.question, 200)}`);
	}

	const logs = events.filter((e) => e.type === "log").slice(legacy ? -1 : -3);
	if (logs.length) {
		lines.push("", "Last log blocks (where the teaching stopped):");
		for (const e of logs) {
			const text = String(e.markdown || "");
			lines.push("---", legacy ? text.slice(-4000) : text.length > 1500 ? `${text.slice(0, 1500)}…` : text);
		}
	}
	if (legacy) lines.push("", "(This session was saved before full history was kept, so only the log text came back: no map or answers.)");
	return lines.join("\n");
}

// ── matching drill ──────────────────────────────────────────────────────────

async function runMatch(args) {
	const pairs = (args.pairs || []).map((p, i) => ({
		id: `r${i}`,
		prompt: String(p.prompt),
		answer: String(p.answer).trim(),
		explanation: p.explanation ? String(p.explanation) : "",
		node: p.node ? String(p.node) : "",
	}));
	if (pairs.length < 2) throw new Error("match requires at least two pairs");
	const bank = shuffled([...new Set([...pairs.map((p) => p.answer), ...(args.distractors || []).map((d) => String(d).trim())])]);

	// The browser grades locally (so retries are instant) and posts a full
	// attempt history when the learner finishes.
	const answer = await ui.openPrompt({
		kind: "match",
		question: args.title,
		details: args.instructions,
		rows: shuffled(pairs).map(({ id, prompt, answer, explanation }) => ({ id, prompt, answer, explanation })),
		bank,
	});

	const attempts = answer.attempts || {}; // rowId → [picked, picked, …]
	const revealed = new Set(answer.revealed || []);
	const dontKnow = new Set(answer.dontKnow || []);
	const notes = answer.notes || {}; // rowId → [note, …]
	const results = pairs.map((p) => {
		const tries = (attempts[p.id] || []).map(String);
		const firstTry = tries[0] === p.answer && !revealed.has(p.id);
		const rowNotes = (notes[p.id] || []).map(String);
		return { ...p, tries, firstTry, revealed: revealed.has(p.id), dontKnow: dontKnow.has(p.id), notes: rowNotes };
	});
	const first = results.filter((r) => r.firstTry).length;

	const touched = results.filter((r) => r.node).map((r) => ({ id: r.node, status: r.firstTry ? "solid" : "shaky" }));
	if (touched.length) applyProgress({ nodes: touched });

	ui.closePrompt(answer.id, { first, total: pairs.length, results });

	const missLine = (r) =>
		`- ${r.prompt} → **${r.answer}**${r.dontKnow ? " (said I don't know)" : r.revealed ? " (revealed)" : ""}; tried: ${r.tries.filter((t) => t !== r.answer).join(", ") || "—"}${r.notes.length ? `; note: "${r.notes.join(" · ")}"` : ""}`;
	const misses = results.filter((r) => !r.firstTry);
	sessionLog.append(
		[
			`### Matching drill — ${first}/${pairs.length} first try`,
			"",
			`**${args.title}**`,
			"",
			"| Prompt | Answer | |",
			"|---|---|---|",
			...results.map((r) => `| ${r.prompt} | ${r.answer} | ${r.firstTry ? "✓" : r.dontKnow ? "?" : r.revealed ? "👁" : "✗"}${r.notes.length ? ` · ${r.notes.join(" · ")}` : ""} |`),
		].join("\n"),
	);
	ui.noteSession();

	const lines = [`Drill: ${args.title}`, `First-try score: ${first}/${pairs.length}`];
	if (misses.length) lines.push("Missed first time:", ...misses.map(missLine));
	const notedHits = results.filter((r) => r.firstTry && r.notes.length);
	if (notedHits.length) lines.push("Notes on rows they got right:", ...notedHits.map((r) => `- ${r.prompt} → ${r.answer}; note: "${r.notes.join(" · ")}"`));
	if (progressMap.nodes.length) lines.push(progressSummary());
	return lines.join("\n");
}

let announcedModel = null;

function runLog(args) {
	if (args.title) sessionLog.setTitle(args.title);
	// Self-reported by the teaching agent — the server has no way to verify it.
	if (args.model && args.model !== announcedModel) {
		announcedModel = args.model;
		ui.emit({ type: "meta", model: args.model });
	}
	const file = sessionLog.append(args.markdown);
	ui.emit({ type: "log", markdown: args.markdown });
	ui.noteSession();
	ui.ensureBrowser();
	return `Logged to ${file} — live at ${ui.url()}`;
}

// ── JSON-RPC plumbing ───────────────────────────────────────────────────────

function send(msg) {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
	const { id, method, params } = msg;

	switch (method) {
		case "initialize":
			reply(id, {
				protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "learn", version: "1.0.0" },
				instructions:
					`The lesson the learner reads is the log at ${ui.url()}, which opens by itself on the first tool call. ` +
					"Quizzes and questions write themselves there; prose only appears if you mirror it with the `log` tool. " +
					"Always quote this exact URL — the port shifts when another learn session is already running. " +
					"Lessons are saved to sessions/ with their full history (log, answers, drills, progress map). " +
					"If the learner wants to continue an earlier lesson, call `resume` (or `sessions` first to pick one) " +
					"instead of starting over; it redraws everything and tells you where the teaching stopped." +
					latestSessionHint(),
			});
			return;

		case "notifications/initialized":
		case "notifications/cancelled":
			return; // notifications get no response

		case "ping":
			reply(id, {});
			return;

		case "tools/list":
			reply(id, { tools: TOOLS });
			return;

		case "tools/call": {
			const name = params?.name;
			const args = params?.arguments || {};
			try {
				let text;
				if (name === "quiz") text = await runQuiz(args);
				else if (name === "ask_user_question") text = await runAsk(args);
				else if (name === "log") text = runLog(args);
				else if (name === "match") text = await runMatch(args);
				else if (name === "progress") text = runProgress(args);
				else if (name === "free_response") text = await runFreeResponse(args);
				else if (name === "sessions") text = runSessions();
				else if (name === "resume") text = runResume(args);
				else throw new Error(`unknown tool: ${name}`);
				reply(id, { content: [{ type: "text", text }] });
			} catch (err) {
				reply(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
			}
			return;
		}

		default:
			if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
	}
}

if (process.argv.includes("--serve")) {
	// Browse mode: no MCP client. If a learn server is already up anywhere in the
	// port range — usually one Claude Code spawned — open that one rather than
	// starting a second, disconnected copy the lesson can never reach.
	const existing = await ui.findRunning();
	if (existing) {
		const how = existing.mode === "live" ? " (live session)" : "";
		process.stderr.write(`learn is already running${how} — opening ${existing.url}\n`);
		ui.openBrowser(existing.url);
		process.exit(0);
	}

	ui.setMode("browse");
	const url = await ui.start();
	process.stderr.write(`learn UI on ${url} (browse-only — start Claude Code for a live session)\n`);
	ui.openBrowser(url);
	// Nothing else to do; the HTTP server keeps the process alive.
} else {
	await runMcp();
}

async function runMcp() {
	const baseUrl = await ui.start();
	process.stderr.write(`learn UI listening on ${baseUrl}\n`);

	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let msg;
		try {
			msg = JSON.parse(trimmed);
		} catch {
			return;
		}
		handle(msg).catch((err) => {
			if (msg.id !== undefined) replyError(msg.id, -32603, String(err?.message || err));
		});
	});
	rl.on("close", () => process.exit(0));
}
