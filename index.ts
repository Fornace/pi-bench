/**
 * pi-bench - Pi extension entry point.
 *
 * Registers /bench slash command to find the fastest, cheapest models
 * among all available providers. The actual bench logic lives in bench.mts
 * and runs on the current Node runtime so it builds its own registry
 * without runtime npx package downloads.
 */

import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { showBenchmarkUI } from "./ui.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export { showBenchmarkUI } from "./ui.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("bench", {
		description: "Run LLM model benchmark probe across all registered providers",
		handler: async (args, ctx) => {
			const benchScript = path.join(__dirname, "bench.mts");

			let outputDir = __dirname;
			const match = args.match(/--output-dir\s+([^\s]+)/);
			if (match) outputDir = match[1]!;
			const dryRun = /(?:^|\s)--dry-run(?:\s|$)/.test(args);

			const hasUI = Boolean(ctx?.hasUI);
			if (!hasUI) {
				console.log("[pi-bench] Running bench (no UI)...");
			} else {
				ctx.ui.notify(dryRun ? "Inspecting benchmark candidates..." : "Running model benchmark...", "info");
			}

			const hostNodeModules = path.resolve(getPackageDir(), "..", "..");
			const nodePath = [hostNodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
			const spawnArgs = ["--experimental-strip-types", benchScript, "--output-dir", outputDir];
			if (dryRun) spawnArgs.push("--dry-run");
			const child = spawn(process.execPath, spawnArgs, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, NODE_PATH: nodePath },
				cwd: __dirname,
				signal: ctx?.signal,
			});

			let stderr = "";

			child.stdout.on("data", (chunk) => {
				if (hasUI) return;
				const lines = chunk.toString().split("\n");
				for (const line of lines) {
					if (line.includes("->") || line.includes("done in") || line.includes("timings:") || line.includes("filter:")) {
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

			if (dryRun) {
				if (hasUI) ctx.ui.notify(`Benchmark candidate list written to ${path.join(outputDir, "bench-candidates.txt")}`, "info");
				return;
			}

			const csvPath = path.join(outputDir, "bench-results-v6.csv");
			if (fs.existsSync(csvPath)) {
				if (hasUI) {
					try {
						await showBenchmarkUI(ctx, csvPath, "Bench complete. Top models");
					} catch (err) {
						console.error("[pi-bench] UI error:", err instanceof Error ? err.message : String(err));
					}
				} else {
					const csv = fs.readFileSync(csvPath, "utf8");
					const lines = csv.split("\n").filter((l) => l.trim());
					const okLines = lines.slice(1).filter((l) => {
						const rank = l.split(",")[0];
						return rank && rank !== "-";
					});
					const top5 = okLines.slice(0, 5).map((line, i) => {
						const cols = line.split(",");
						return `  ${i + 1}. ${cols[1]} (${cols[2]}) — ${cols[8]}ms, $${cols[14]}`;
					});
					console.log(`[pi-bench] Bench complete! ${okLines.length} models OK.\n\nTop 5:\n${top5.join("\n")}\n\nFull results: ${csvPath}`);
				}
			}
		},
	});
}
