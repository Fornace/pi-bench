/**
 * pi-bench - Pi extension entry point.
 *
 * Registers /bench slash command to find the fastest, cheapest models
 * among all available providers. The actual bench logic lives in bench.mts
 * and runs as a standalone subprocess so it builds its own registry
 * without interfering with the running session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { showBenchmarkUI } from "./ui.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export { showBenchmarkUI } from "./ui.js";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("bench", {
		description: "Run LLM model benchmark probe across all registered providers",
		handler: async (args, ctx) => {
			const benchScript = path.join(__dirname, "bench.mts");
			
			// Basic argument parsing
			let outputDir = __dirname;
			const match = args.match(/--output-dir\s+([^\s]+)/);
			if (match) outputDir = match[1]!;

			const hasUI = Boolean(ctx?.hasUI);

			if (!hasUI) {
				console.log("[pi-bench] Running bench (no UI)...");
			} else {
				ctx.ui.notify("Running model benchmark...", "info");
			}

			const child = spawn("npx", ["-y", "-p", "tsx", "tsx", benchScript, "--output-dir", outputDir], {
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
				cwd: __dirname,
			});

			let stderr = "";

			// When UI is active, suppress console output to avoid
			// corrupting the TUI display. Only show output in no-UI mode.
			child.stdout.on("data", (chunk) => {
				if (hasUI) return;
				const lines = chunk.toString().split("\n");
				for (const line of lines) {
					if (line.includes("->") || line.includes("done in") || line.includes("timings:")) {
						console.log(line.trim());
					}
				}
			});

			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});

			await new Promise<void>((resolve, reject) => {
				child.on("close", (code) => {
					if (code === 0) resolve();
					else reject(new Error(`bench exited with code ${code}\n${stderr}`));
				});
				child.on("error", reject);
			});

			// Read and show top results
			const csvPath = path.join(outputDir, "bench-results-v6.csv");
			if (fs.existsSync(csvPath)) {
				if (hasUI) {
					try {
						await showBenchmarkUI(ctx, csvPath, "Bench complete. Top models");
					} catch (err) {
						// UI crash recovery: fall back to plain text summary
						console.error("[pi-bench] UI error:", err instanceof Error ? err.message : String(err));
						const summary = readTopResults(csvPath, 5);
						if (summary) console.log(`[pi-bench] Top models:\n${summary}`);
						console.log(`[pi-bench] Full results: ${csvPath}`);
					}
				} else {
					const summary = readTopResults(csvPath, 5);
					if (summary) console.log(`[pi-bench] Top models:\n${summary}`);
					console.log(`[pi-bench] Results: ${csvPath}`);
				}
			} else {
				if (hasUI) {
					ctx.ui.notify("Bench completed but no CSV found.", "warning");
				}
			}
		},
	});
}

function readTopResults(csvPath: string, count: number): string | undefined {
	const csv = fs.readFileSync(csvPath, "utf8");
	const lines = csv.split("\n").filter((l) => l.trim());
	if (lines.length < 2) return undefined;
	const header = lines[0]!;
	const cols = header.split(",");
	const idxId = cols.indexOf("id");
	const idxLatency = cols.indexOf("t_complete_ms");
	const idxQuality = cols.indexOf("quality");
	const idxProvider = cols.indexOf("provider");

	const topRows = lines.slice(1, count + 1).filter((l) => {
		const rank = l.split(",")[0];
		return rank && rank !== "-";
	});

	if (topRows.length === 0) return undefined;
	return topRows.map((row) => {
		const v = row.split(",");
		return `${v[idxId]!} (${v[idxProvider]!}) - ${v[idxLatency]!}ms [${v[idxQuality]!}]`;
	}).join("\n");
}
