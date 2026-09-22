#!/usr/bin/env node
// mcp.js — MCP stdio server exposing the learning tools to Claude Code.
//
// Tools:
//   quiz               graded multiple-choice, instantly marked in the browser
//   ask_user_question  ungraded preference/decision question
//   log                mirror a teaching message into the session markdown log
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
					"Always quote this exact URL — the port shifts when another learn session is already running.",
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
