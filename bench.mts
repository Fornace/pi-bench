/**
 * Standalone LLM model benchmark probe.
 *
 * Loads pi extensions on Pi 1.4's ModelRuntime/ModelRegistry, probes available
 * chat models with a representative prompt, and ranks them by latency, cost, and quality.
 *
 * Usage:
 *   # CLI:
 *   node --experimental-strip-types bench.mts [--output-dir /path] [--dry-run]
 *
 *   # Programmatic:
 *   import { runBench } from "./bench.mts";
 *   const { results, csvPath, candidatesPath } = await runBench();
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAgentSessionServices, ModelRegistry } from "@earendil-works/pi-coding-agent";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── tunables ───────────────────────────────────────────────────────────

export const PER_CALL_TIMEOUT_MS = 4_000;
export const TOTAL_RUN_TIMEOUT_MS = 30 * 1000;
export const CONCURRENCY_PER_PROVIDER = 8;
export const BATCH_GAP_MS = 200;

const SYSTEM = `You write one-line summaries of user messages. Output a single sentence in past tense. Be specific. No preamble.`;

const PROMPT_TEMPLATES = [
	"I'm trying to debug why my {lang} script hangs after {n} iterations of an HTTPS API call. {pkg}, timeouts already added. The script reads from a config file, authenticates via OAuth2, then loops through a list of {n} endpoints. Each call should return within 200ms but after about 30 iterations the whole thing freezes. No error messages, no stack traces — it just stops. I've added logging before and after each request but the logs don't show where it's getting stuck. Memory usage stays flat so it's not a leak. I'm wondering if it's a connection pool issue or rate limiting on the {api} side.",
	"Need help refactoring a {lang} {thing} that's grown to {n} lines over the past six months. It started as a simple script to sync data between our internal DB and the {api} API, but now it handles auth retries, pagination, webhook callbacks, error reporting, and a scheduling system bolted on top. Every time I touch one part something else breaks. I want to split it into smaller focused modules but I'm not sure where to draw the boundaries. The current version calls {api} in a loop with {pkg} and processes each response inline, which makes it hard to test individual pieces.",
	"My {lang} service returns {n} records from a PostgreSQL query but the HTTP response takes 8-12 seconds. Using {pkg} for the client and {api} for the downstream enrichment calls. The query itself runs in 200ms — I've verified with EXPLAIN ANALYZE. The bottleneck is in the serialization layer: each record gets enriched with a separate API call, then transformed into a JSON response. I've tried batching the enrichment calls but the {api} API doesn't support bulk operations. Considering adding a Redis cache layer but I'm worried about stale data.",
	"Writing a {lang} script to process {n} rows from a CSV export. Each row has an email, a name, and a subscription status. The script needs to validate emails, look up existing records in the {api} CRM via {pkg}, update mismatches, and send a summary report. Memory keeps growing — starts at 40MB and hits 1.2GB by row 500. I'm streaming the CSV with a generator so it shouldn't be loading everything into memory. I suspect the {api} client is caching responses or holding onto connections. Tried forcing garbage collection but it barely helps.",
	"The {lang} {thing} crashes on iteration {n} with a timeout error. Already set retries to 3 with exponential backoff, added circuit breaker logic, and confirmed the {api} API is healthy during the crash window. Using {pkg} as the HTTP client. The weird part is it's always around the same iteration count — not exactly {n}, but between {n} and {n2}. The stack trace points to the connection pool manager. I've tried increasing pool size, reducing keep-alive timeout, and switching to a fresh client per request. Nothing changes the pattern.",
];
const LANGS = ["Python", "Node.js", "Go", "Rust", "Ruby", "TypeScript"];
const THINGS = ["endpoint", "worker", "migration", "scraper", "pipeline", "scheduler"];
const PKGS = ["requests==2.28.1", "axios@1.4", "httpx", "fetch", "got", "urllib3"];
const APIS = ["Stripe", "GitHub", "OpenAI", "AWS", "Cloudflare", "Vercel"];
const NS = ["30", "50", "100", "200", "500", "1000"];
const N2S = ["35", "55", "110", "220", "550", "1100"];

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomPrompt(): string {
	const tpl = pick(PROMPT_TEMPLATES);
	return tpl
		.replace("{lang}", pick(LANGS))
		.replace("{thing}", pick(THINGS))
		.replace("{pkg}", pick(PKGS))
		.replace("{api}", pick(APIS))
		.replace("{n}", pick(NS))
		.replace("{n2}", pick(N2S));
}

// ── types ──────────────────────────────────────────────────────────────

export interface ProbeResult {
	id: string;
	provider: string;
	api: string;
	family: string;
	reasoning: boolean;
	costInput: number;
	costOutput: number;
	tFirstByte: number | null;
	tComplete: number | null;
	promptTokens: number | null;
	outputTokens: number | null;
	tokensEstimated: boolean;
	costUSD: number | null;
	status: string;
	sample: string;
	reasoned: boolean;
	quality: string;
	promptUsed: string;
}

export interface Candidate {
	model: Model<Api>;
	family: string;
	cheap: boolean;
	totalCost: number;
	hasThinkingOff: boolean;
}

export interface BenchStats {
	starting: number;
	dropped_blocklist: number;
	final: number;
}

export interface BenchResult {
	results: ProbeResult[];
	csvPath: string;
	candidatesPath: string;
	stats: BenchStats;
	providerTimings: Map<string, { elapsed: number; count: number; ok: number; fail: number; timeout: number }>;
}

export interface BenchOpts {
	outputDir?: string;
	timeoutMs?: number;
	concurrency?: number;
	dryRun?: boolean;
}

// ── filter ─────────────────────────────────────────────────────────────

const ID_BLOCKLIST_FRAGMENTS: ReadonlyArray<{ frag: string; reason: string }> = [
	{ frag: "embed", reason: "embeddings" },
	{ frag: "audio", reason: "audio i/o" },
	{ frag: "tts", reason: "text-to-speech" },
	{ frag: "whisper", reason: "speech-to-text" },
	{ frag: "transcribe", reason: "speech-to-text" },
	{ frag: "dall-e", reason: "image gen" },
	{ frag: "dalle", reason: "image gen" },
	{ frag: "imagen", reason: "image gen" },
	{ frag: "stable-diffusion", reason: "image gen" },
	{ frag: "midjourney", reason: "image gen" },
	{ frag: "moderation", reason: "classifier" },
	{ frag: "guard", reason: "classifier" },
];

function familyMatch(id: string): string | null {
	const lower = id.toLowerCase();
	if (lower.includes("haiku")) return "haiku";
	if (lower.includes("flash-lite") || lower.includes("flashlite")) return "flash-lite";
	if (lower.includes("nano")) return "nano";
	if (lower.includes("ministral")) return "ministral";
	if (lower.includes("kimi")) return "kimi";
	if (lower.includes("glm")) return "glm";
	if (lower.includes("nova-lite") || lower.includes("nova-micro")) return "nova-lite";
	if (lower.includes("flash")) return "flash";
	if (lower.includes("mini") && !lower.includes("gemini")) return "mini";
	if (lower.includes("turbo")) return "turbo";
	if (lower.includes("lite")) return "lite";
	if (lower.includes("plus")) return "plus";
	if (lower.includes("max")) return "max";
	if (lower.includes("-pro") || lower.includes("/pro")) return "pro";
	return null;
}

const CHEAP_THRESHOLD = 1.0;

function hasThinkingOffSupport(m: Model<Api>): boolean {
	if (!m.reasoning) return true;
	if (m.api === "anthropic-messages") return true;
	if (m.api === "google-generative-ai" || m.api === "google-vertex") return true;
	if (m.thinkingLevelMap) {
		const map = m.thinkingLevelMap as Record<string, unknown>;
		if (map.off !== null || map.minimal !== null || map.low !== null) return true;
	}
	return false;
}

function filterCandidates(all: Model<Api>[]): { candidates: Candidate[]; stats: BenchStats; dropped: { id: string; reason: string }[] } {
	const stats: BenchStats = { starting: all.length, dropped_blocklist: 0, final: 0 };
	const dropped: { id: string; reason: string }[] = [];
	const candidates: Candidate[] = [];

	for (const m of all) {
		const lower = m.id.toLowerCase();
		const blockHit = ID_BLOCKLIST_FRAGMENTS.find((b) => lower.includes(b.frag));
		if (blockHit) {
			stats.dropped_blocklist++;
			dropped.push({ id: m.id, reason: `blocklist:${blockHit.frag}` });
			continue;
		}
		const fam = familyMatch(m.id);
		const total = (m.cost?.input ?? 0) + (m.cost?.output ?? 0);
		const cheap = total > 0 && total < CHEAP_THRESHOLD;
		candidates.push({ model: m, family: fam ?? "(other)", cheap, totalCost: total, hasThinkingOff: hasThinkingOffSupport(m) });
	}

	stats.final = candidates.length;
	return { candidates, stats, dropped };
}

// ── quality classification ─────────────────────────────────────────────

function classifyQuality(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "empty";
	const lower = trimmed.toLowerCase();
	if (/^(i (cannot|can't|am unable|won't))|sorry,? i/.test(lower)) return "refusal";
	if (trimmed.endsWith("?")) return "question";
	const sentenceTerminators = (trimmed.match(/[.!?](?:\s|$)/g) ?? []).length;
	if (sentenceTerminators > 1) return "multi-sentence";
	if (trimmed.includes("```") || /^(recap|summary|answer)\s*:/i.test(trimmed)) return "formatted";
	return "ok";
}

// ── probing ────────────────────────────────────────────────────────────

async function probeOne(registry: ModelRegistry, c: Candidate, timeoutMs: number): Promise<ProbeResult> {
	const m = c.model;
	const base: ProbeResult = {
		id: m.id, provider: m.provider, api: m.api, family: c.family, reasoning: m.reasoning,
		costInput: m.cost?.input ?? 0, costOutput: m.cost?.output ?? 0,
		tFirstByte: null, tComplete: null, promptTokens: null, outputTokens: null,
		tokensEstimated: false, costUSD: null, status: "init", sample: "", reasoned: false, quality: "n/a", promptUsed: "",
	};

	const promptText = randomPrompt();
	base.promptUsed = promptText;

	const auth = await registry.getApiKeyAndHeaders(m);
	if (!auth.ok) { base.status = `error:auth:${auth.error.slice(0, 60)}`; return base; }

	const t0 = performance.now();
	let firstByteAt: number | null = null;
	let running = "";
	let finalMessage: AssistantMessage | undefined;
	let timedOut = false;
	const controller = new AbortController();
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	timer.unref?.();

	let raceResult: "ok" | "timeout" | Error = "ok";
	try {
		const events = registry.streamSimple(m, {
			systemPrompt: SYSTEM,
			messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
		}, { maxTokens: 128, temperature: 0, reasoning: "off", signal: controller.signal, maxRetries: 0 });

		for await (const event of events) {
			if (timedOut) break;
			if (event.type === "text_delta") {
				if (firstByteAt === null) firstByteAt = performance.now();
				running += event.delta;
			} else if (event.type === "text_end") {
				if (firstByteAt === null) firstByteAt = performance.now();
				if (!running && typeof event.content === "string") running = event.content;
			} else if (event.type === "thinking_start") {
				base.reasoned = true;
			} else if (event.type === "done") {
				finalMessage = event.message;
			} else if (event.type === "error") {
				finalMessage = event.error;
				if (timedOut || event.error?.stopReason === "aborted") {
					raceResult = "timeout";
					break;
				}
				const reason = event.error?.errorMessage ?? `stop=${event.error?.stopReason}`;
				throw new Error(reason);
			}
		}
		if (timedOut) raceResult = "timeout";
	} catch (err) {
		raceResult = timedOut ? "timeout" : (err as Error);
	} finally {
		clearTimeout(timer);
	}

	const tEnd = performance.now();
	base.tComplete = Math.round(tEnd - t0);
	base.tFirstByte = firstByteAt !== null ? Math.round(firstByteAt - t0) : null;

	if (raceResult === "timeout") { base.status = "timeout"; base.sample = running.replace(/[\r\n]+/g, " ").slice(0, 60); return base; }
	if (raceResult instanceof Error) {
		const msg = raceResult.message.replace(/[\r\n]+/g, " ");
		let short = msg;
		const m402 = msg.match(/402[^"]*/); const m401 = msg.match(/401[^"]*/); const m429 = msg.match(/429[^"]*/); const m400 = msg.match(/400[^"]*/);
		if (m402) short = `402 ${msg.includes("credit") ? "credits" : "payment"}`;
		else if (m401) short = "401 auth";
		else if (m429) short = "429 rate";
		else if (m400) short = `400 ${msg.slice(0, 40)}`;
		else short = msg.slice(0, 60);
		base.status = `error:${short}`; base.sample = running.replace(/[\r\n]+/g, " ").slice(0, 60); return base;
	}

	if (finalMessage?.usage) { base.promptTokens = finalMessage.usage.input ?? null; base.outputTokens = finalMessage.usage.output ?? null; base.tokensEstimated = false; }
	if (!running && finalMessage) {
		const parts: string[] = [];
		for (const part of finalMessage.content ?? []) {
			if (part && (part as any).type === "text" && typeof (part as any).text === "string") parts.push((part as any).text);
		}
		if (parts.length > 0) running = parts.join("");
	}

	if (!running.trim()) { base.status = "empty"; base.sample = ""; base.quality = "empty"; }
	else { base.status = "ok"; base.sample = running.replace(/\s+/g, " ").trim().slice(0, 60); base.quality = classifyQuality(running); }

	if (base.outputTokens === null) { base.outputTokens = Math.max(1, Math.round(running.length / 4)); base.tokensEstimated = true; }
	if (base.promptTokens === null) { base.promptTokens = Math.round((SYSTEM.length + promptText.length) / 4); base.tokensEstimated = true; }
	base.costUSD = ((base.promptTokens * (m.cost?.input ?? 0)) + (base.outputTokens * (m.cost?.output ?? 0))) / 1_000_000;
	return base;
}

// ── concurrency runner ─────────────────────────────────────────────────

async function runWithConcurrency<T, R>(
	items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>,
	gapMs = 0, totalTimeoutMs = TOTAL_RUN_TIMEOUT_MS,
	onResult?: (idx: number, result: R) => void,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	let aborted = false;

	async function worker(): Promise<void> {
		while (!aborted) {
			const idx = cursor++;
			if (idx >= items.length) return;
			try { results[idx] = await fn(items[idx]!, idx); } catch (err) { results[idx] = err as any; }
			onResult?.(idx, results[idx]!);
			if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
		}
	}

	const workers = Array.from({ length: limit }, () => worker());
	const totalDeadline = new Promise<void>((resolve) => setTimeout(() => { aborted = true; resolve(); }, totalTimeoutMs));
	await Promise.race([Promise.all(workers), totalDeadline]);
	return results;
}

// ── output ─────────────────────────────────────────────────────────────

function fmtMs(v: number | null): string { return v === null ? "-" : `${v}ms`; }
function fmtUSD(v: number | null): string { return v === null ? "-" : v < 0.000001 ? "~$0" : `$${v.toFixed(6)}`; }
function pad(s: string, w: number): string { return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length); }

export function printTable(results: ProbeResult[]): string {
	const ok = results.filter((r) => r.status === "ok").sort((a, b) => (a.tComplete ?? 99999) - (b.tComplete ?? 99999));
	const fail = results.filter((r) => r.status !== "ok");
	const lines: string[] = [];
	lines.push(pad("RANK", 4) + " " + pad("FB", 7) + " " + pad("TOTAL", 7) + " " + pad("COST", 12) + " " + pad("TOK_O", 6) + " " + pad("FAMILY", 10) + " " + pad("PROVIDER", 18) + " " + pad("ID", 50) + " " + pad("RZN", 4) + " " + pad("QUALITY", 16) + " " + "STATUS / SAMPLE");
	lines.push("-".repeat(180));
	let i = 1;
	for (const r of ok) {
		lines.push(pad(String(i++), 4) + " " + pad(fmtMs(r.tFirstByte), 7) + " " + pad(fmtMs(r.tComplete), 7) + " " + pad(fmtUSD(r.costUSD), 12) + " " + pad(String(r.outputTokens ?? "-") + (r.tokensEstimated ? "~" : ""), 6) + " " + pad(r.family, 10) + " " + pad(r.provider, 18) + " " + pad(r.id, 50) + " " + pad(r.reasoned ? "yes" : "no", 4) + " " + pad(r.quality, 16) + " " + r.sample);
	}
	if (fail.length > 0) {
		lines.push("-".repeat(180));
		lines.push("FAILURES:");
		for (const r of fail) {
			lines.push(pad("-", 4) + " " + pad(fmtMs(r.tFirstByte), 7) + " " + pad(fmtMs(r.tComplete), 7) + " " + pad("-", 12) + " " + pad("-", 6) + " " + pad(r.family, 10) + " " + pad(r.provider, 18) + " " + pad(r.id, 50) + " " + pad(r.reasoned ? "yes" : "no", 4) + " " + pad(r.quality, 16) + " " + r.status);
		}
	}
	return lines.join("\n");
}

function writeCsv(results: ProbeResult[], filePath: string): void {
	const header = "rank,id,provider,api,family,reasoning,reasoned,t_first_byte_ms,t_complete_ms,prompt_tokens,output_tokens,tokens_estimated,cost_input,cost_output,cost_usd,status,quality,sample";
	const ok = results.filter((r) => r.status === "ok").sort((a, b) => (a.tComplete ?? 99999) - (b.tComplete ?? 99999));
	const fail = results.filter((r) => r.status !== "ok");
	const sorted = [...ok, ...fail];
	const lines = [header];
	for (let i = 0; i < sorted.length; i++) {
		const r = sorted[i]!;
		const rank = r.status === "ok" ? String(i + 1) : "-";
		const sample = (r.sample ?? "").replace(/[\r\n]+/g, " ").replace(/"/g, '""');
		const safeStatus = (r.status ?? "").replace(/[\r\n]+/g, " ");
		lines.push([rank, r.id, r.provider, r.api, r.family, r.reasoning, r.reasoned, r.tFirstByte ?? "", r.tComplete ?? "", r.promptTokens ?? "", r.outputTokens ?? "", r.tokensEstimated, r.costInput, r.costOutput, r.costUSD ?? "", safeStatus, r.quality, `"${sample}"`].join(","));
	}
	fs.writeFileSync(filePath, lines.join("\n"));
}

function writeCandidatesCsv(candidates: Candidate[], dropped: { id: string; reason: string }[], filePath: string): void {
	const lines: string[] = [];
	lines.push("# CANDIDATES (passed filter)");
	lines.push("id,provider,api,reasoning,has_thinking_off,cost_in,cost_out,total_cost,ctx,family,cheap");
	for (const c of candidates) {
		lines.push([c.model.id, c.model.provider, c.model.api, c.model.reasoning, c.hasThinkingOff, c.model.cost?.input ?? 0, c.model.cost?.output ?? 0, c.totalCost.toFixed(4), c.model.contextWindow ?? 0, c.family, c.cheap].join(","));
	}
	lines.push("");
	lines.push("# DROPPED");
	lines.push("id,reason");
	for (const d of dropped) lines.push(`${d.id},"${d.reason}"`);
	fs.writeFileSync(filePath, lines.join("\n"));
}

// ── main bench logic ───────────────────────────────────────────────────

export async function runBench(opts: BenchOpts = {}): Promise<BenchResult> {
	const outputDir = opts.outputDir ?? __dirname;
	fs.mkdirSync(outputDir, { recursive: true });
	const timeoutMs = opts.timeoutMs ?? TOTAL_RUN_TIMEOUT_MS;
	const concurrency = opts.concurrency ?? CONCURRENCY_PER_PROVIDER;
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent");

	console.log("");
	console.log("╔══════════════════════════════════════════════════════════╗");
	console.log("║              🔬  pi-bench  v0.3.0  —  model probe      ║");
	console.log("║  randomised prompts · per-call 4s · total 30s · q8     ║");
	console.log("╚══════════════════════════════════════════════════════════╝");
	console.log("");
	console.log("[bench] loading registry...");
	const services = await createAgentSessionServices({ cwd: process.cwd(), agentDir });
	for (const diag of services.diagnostics) {
		if (diag.type === "error") console.error(`[bench] ${diag.message}`);
	}
	const registry = new ModelRegistry(services.modelRuntime);

	const all = registry.getAll();
	const available = registry.getAvailable();
	console.log(`[bench] registry: total=${all.length} available=${available.length}`);

	const { candidates, stats, dropped } = filterCandidates(available);
	console.log(`[bench] filter: starting=${stats.starting} final=${stats.final}`);

	const candidatesPath = path.join(outputDir, "bench-candidates.txt");
	writeCandidatesCsv(candidates, dropped, candidatesPath);
	console.log(`[bench] wrote ${candidatesPath}`);

	const csvFile = path.join(outputDir, "bench-results-v6.csv");
	if (opts.dryRun) {
		return { results: [], csvPath: csvFile, candidatesPath, stats, providerTimings: new Map() };
	}

	const byProvider = new Map<string, Candidate[]>();
	for (const c of candidates) {
		const bucket = byProvider.get(c.model.provider) ?? [];
		bucket.push(c);
		byProvider.set(c.model.provider, bucket);
	}
	console.log(`[bench] probing ${candidates.length} candidates across ${byProvider.size} providers (concurrency=${concurrency}/provider), per-call timeout=${PER_CALL_TIMEOUT_MS}ms...`);

	const t0 = performance.now();
	const results: ProbeResult[] = new Array(candidates.length);
	const providerTimings = new Map<string, { start: number; end: number; count: number; ok: number; fail: number; timeout: number }>();

	let globalCursor = 0;
	const providerPromises: Promise<void>[] = [];
	for (const [provider, group] of byProvider) {
		const startIdx = globalCursor;
		const timing = { start: performance.now(), end: 0, count: group.length, ok: 0, fail: 0, timeout: 0 };
		providerTimings.set(provider, timing);
		providerPromises.push(
			runWithConcurrency(group, concurrency, async (c, idx) => {
				const r = await probeOne(registry, c, PER_CALL_TIMEOUT_MS);
				const tag = r.status === "ok" ? `${r.tComplete}ms ${r.outputTokens}tok q=${r.quality}` : r.status;
				const globalIdx = startIdx + idx;
				results[globalIdx] = r;
				const promptSnip = r.promptUsed ? `[${r.promptUsed.slice(0, 20)}…]` : "";
				console.log(`[bench] [${provider}] ${c.model.id.padEnd(45)} -> ${tag} ${promptSnip}`);
				return r;
			}, BATCH_GAP_MS, timeoutMs, (_idx, r) => {
				if (r.status === "ok") timing.ok++;
				else if (r.status === "timeout") timing.timeout++;
				else timing.fail++;
				const filledResults = results.filter(Boolean);
				writeCsv(filledResults, csvFile);
			}).then(() => { timing.end = performance.now(); })
		);
		globalCursor += group.length;
	}
	await Promise.all(providerPromises);

	const dur = Math.round((performance.now() - t0) / 1000);
	console.log(`[bench] probes done in ${dur}s`);

	console.log("\n[bench] provider timings:");
	const sortedProviders = [...providerTimings.entries()].sort((a, b) => (b[1].end - b[1].start) - (a[1].end - a[1].start));
	const finalProviderTimings = new Map<string, { elapsed: number; count: number; ok: number; fail: number; timeout: number }>();
	for (const [provider, t] of sortedProviders) {
		const elapsed = Math.round((t.end - t.start) / 1000);
		console.log(`  ${provider.padEnd(18)} ${elapsed}s  (${t.count} models: ${t.ok} ok, ${t.fail} err, ${t.timeout} timeout)`);
		finalProviderTimings.set(provider, { elapsed, count: t.count, ok: t.ok, fail: t.fail, timeout: t.timeout });
	}

	const table = printTable(results);
	console.log("");
	console.log(table);

	writeCsv(results, csvFile);
	console.log(`\n[bench] wrote ${csvFile}`);

	return { results, csvPath: csvFile, candidatesPath, stats, providerTimings: finalProviderTimings };
}

// ── CLI entry point ────────────────────────────────────────────────────

async function main() {
	let outputDir: string | undefined;
	let dryRun = false;
	for (let i = 2; i < process.argv.length; i++) {
		if (process.argv[i] === "--output-dir" && process.argv[i + 1]) {
			outputDir = process.argv[++i];
		} else if (process.argv[i] === "--dry-run") {
			dryRun = true;
		}
	}
	await runBench({ outputDir, dryRun });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("bench.mts")) {
	main().then(() => process.exit(0)).catch((err) => { console.error("[bench] FATAL:", err); process.exit(1); });
}
