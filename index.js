"use strict";
/**
 * pi-bench - Pi extension entry point.
 *
 * Registers /bench slash command to find the fastest, cheapest models
 * among all available providers. The actual bench logic lives in bench.mts
 * and runs as a standalone subprocess so it builds its own registry
 * without interfering with the running session.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = default_1;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_url_1 = require("node:url");
const node_child_process_1 = require("node:child_process");
const __filename = (0, node_url_1.fileURLToPath)(import.meta.url);
const __dirname = path.dirname(__filename);
function default_1(pi) {
    pi.registerCommand("bench", {
        description: "Run LLM model benchmark probe across all registered providers",
        usage: "/bench [--output-dir /path]",
        async run(ctx, args) {
            const benchScript = path.join(__dirname, "bench.mts");
            const outputDir = args?.outputDir ?? __dirname;
            if (!ctx?.hasUI) {
                console.log("[pi-bench] Running bench (no UI)...");
            }
            else {
                ctx.ui.notify("Running model benchmark...", "info");
            }
            const child = (0, node_child_process_1.spawn)("npx", ["-y", "-p", "tsx", "tsx", benchScript, "--output-dir", outputDir], {
                stdio: ["ignore", "pipe", "pipe"],
                env: process.env,
                cwd: __dirname,
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
                // Stream progress to console
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
            await new Promise((resolve, reject) => {
                child.on("close", (code) => {
                    if (code === 0)
                        resolve();
                    else
                        reject(new Error(`bench exited with code ${code}\n${stderr}`));
                });
                child.on("error", reject);
            });
            // Read and show top results
            const csvPath = path.join(outputDir, "bench-results-v6.csv");
            if (fs.existsSync(csvPath)) {
                const csv = fs.readFileSync(csvPath, "utf8");
                const lines = csv.split("\n").filter((l) => l.trim());
                const header = lines[0];
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
                        return `${cols[idxId]} (${cols[idxProvider]}) - ${cols[idxLatency]}ms [${cols[idxQuality]}]`;
                    }).join("\n");
                    if (ctx?.hasUI) {
                        ctx.ui.notify(`Bench complete. Top models:\n${summary}`, "info");
                    }
                    console.log(`[pi-bench] Top models:\n${summary}`);
                }
                console.log(`[pi-bench] Results: ${csvPath}`);
            }
            else {
                if (ctx?.hasUI) {
                    ctx.ui.notify("Bench completed but no CSV found.", "warning");
                }
            }
        },
    });
}
