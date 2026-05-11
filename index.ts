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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default function (pi: ExtensionAPI) {
	pi.registerCommand("bench", {
		description: "Run LLM model benchmark probe across all registered providers",
		usage: "/bench [--output-dir /path]",
		handler: async (args, ctx) => {
			const benchScript = path.join(__dirname, "bench.mts");
			const outputDir = args?.outputDir ?? __dirname;

			if (!ctx?.hasUI) {
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

			child.stdout.on("data", (chunk) => {
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
				const csv = fs.readFileSync(csvPath, "utf8");
				const lines = csv.split("\n").filter((l) => l.trim());
				const header = lines[0]!;
				const idxId = header.split(",").indexOf("id");
				const idxLatency = header.split(",").indexOf("t_complete_ms");
				const idxQuality = header.split(",").indexOf("quality");
				const idxProvider = header.split(",").indexOf("provider");

				const topRows = lines.slice(1, 6).filter((l) => {
					const rank = l.split(",")[0];
					return rank && rank !== "-";
				});

				if (topRows.length > 0) {
					const summary = topRows.map((row) => {
						const cols = row.split(",");
						return `${cols[idxId]!} (${cols[idxProvider]!}) - ${cols[idxLatency]!}ms [${cols[idxQuality]!}]`;
					}).join("\n");

					if (ctx?.hasUI) {
						ctx.ui.notify(`Bench complete. Top models:\n${summary}`, "info");
					}
					console.log(`[pi-bench] Top models:\n${summary}`);
				}

				console.log(`[pi-bench] Results: ${csvPath}`);
			} else {
				if (ctx?.hasUI) {
					ctx.ui.notify("Bench completed but no CSV found.", "warning");
				}
			}
		},
	});
}
