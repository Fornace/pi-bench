import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";

export async function showBenchmarkUI(
	ctx: ExtensionContext,
	csvPath: string,
	title: string = "Benchmark Results"
): Promise<string | undefined> {
	if (!fs.existsSync(csvPath)) return undefined;

	const csv = fs.readFileSync(csvPath, "utf8");
	const lines = csv.split("\n").filter((l) => l.trim());
	if (lines.length < 2) return undefined;

	const header = lines[0]!;
	const allRows = lines.slice(1).filter((l) => {
		const rank = l.split(",")[0];
		return rank && rank !== "-";
	});

	if (allRows.length === 0) return undefined;

	const hCols = header.split(",");
	const idxId = hCols.indexOf("id");
	const idxProvider = hCols.indexOf("provider");
	const idxLatency = hCols.indexOf("t_complete_ms");
	const idxCost = hCols.indexOf("cost_usd");
	const idxTok = hCols.indexOf("output_tokens");
	const idxQuality = hCols.indexOf("quality");
	const idxReasoned = hCols.indexOf("reasoned");

	const idW = 32;
	const provW = 12;
	const latW = 7;
	const costW = 11;
	const tokW = 4;
	const qualW = 6;

	const padR = (s: string, w: number) => s.padEnd(w);
	const padL = (s: string, w: number) => s.padStart(w);

	const fmtCost = (raw: string): string => {
		const n = parseFloat(raw);
		if (isNaN(n) || n === 0) return "-";
		if (n < 0.0001) return `$${n.toFixed(7)}`;
		if (n < 0.01) return `$${n.toFixed(6)}`;
		if (n < 1) return `$${n.toFixed(5)}`;
		return `$${n.toFixed(3)}`;
	};

	// Labels MUST be plain text — no ANSI codes.
	// SelectList applies its own rendering; pre-formatted text
	// causes escape-code nesting that garbles the display.
	const pickOptions = allRows.map((line, i) => {
		const v = line.split(",");
		const id = v[idxId]!.slice(0, idW);
		const prov = (v[idxProvider] ?? "-").slice(0, provW);
		const lat = v[idxLatency]!;
		const cost = fmtCost(v[idxCost] ?? "");
		const tok = v[idxTok] ?? "-";
		const qual = (v[idxQuality] ?? "-").slice(0, qualW);
		const reasoned = v[idxReasoned] === "yes" ? " 🧠" : "";

		const rank = String(i + 1).padStart(3);
		const prefix = i === 0 ? "👑" : rank;
		return `${prefix} ${padR(id, idW)} ${padR(prov, provW)} ${padL(lat + "ms", latW)} ${padL(cost, costW)} ${padL(tok, tokW)} ${qual}${reasoned}`;
	});


	return await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		class CustomSelect extends Container {
			private list: SelectList;
			constructor() {
				super();
				const w = tui.terminal.columns > 80 ? 80 : tui.terminal.columns;
				this.addChild(new Text(theme.fg("dim", "─".repeat(w)), 1, 0));
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("accent", theme.bold(title)) + " " + theme.fg("dim", `(${allRows.length} tested)`), 1, 0));
				this.addChild(new Spacer(1));
				const colHeader = theme.fg("dim", `     ${padR("model", idW)} ${padR("provider", provW)} ${padL("latency", latW)} ${padL("cost", costW)} ${padL("tok", tokW)} quality`);
				this.addChild(new Text(colHeader, 1, 0));

				const items = pickOptions.map((opt, i) => {
					const v = allRows[i]!.split(",");
					const rawId = v[idxId]!;
					return { value: rawId, label: opt };
				});
				
				this.list = new SelectList(items, 10, {
					selectedPrefix: () => theme.fg("accent", "→ "),
					selectedText: (t) => theme.bold(theme.fg("accent", t)),
					description: (t) => theme.fg("dim", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("error", t)
				});
				this.addChild(this.list);

				this.addChild(new Spacer(1));
				this.addChild(new Text("↑↓ navigate  Enter select  Esc cancel", 1, 0));
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("dim", "─".repeat(w)), 1, 0));

				this.list.onSelect = (item) => done(item.value);
				this.list.onCancel = () => done(undefined);
			}

			handleInput(keyData: string) {
				if (keybindings.matches(keyData, "tui.select.cancel")) {
					done(undefined);
					return;
				}
				this.list.handleInput(keyData);
			}
		}
		return new CustomSelect();
	});
}
