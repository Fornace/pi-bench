# pi-bench

![pi-bench banner](https://fcskjxapefiqdclrvbtw.supabase.co/storage/v1/object/public/assets/pi-packages/pi-bench-banner.jpg)

Find the fastest, cheapest LLM models among all registered providers.

Probes every available model with a real `stream()` call using a representative prompt, then ranks by latency, cost, and output quality. Designed to feed smart model selection into [pi-recap](https://github.com/fornace/pi-recap) and other pi extensions.

## Features

- **Universal provider loading** — discovers and loads all pi extensions (Alibaba, Kimi, etc.) the same way pi does
- **Real probes** — fires actual streaming API calls, measures time-to-first-byte and completion
- **Quality scoring** — classifies responses as ok / multi-sentence / refusal / question / empty
- **Cost aware** — calculates per-call cost in USD using model pricing
- **30s hard timeout** — if the full probe doesn't finish, the incremental CSV already contains every completed probe
- **Per-provider concurrency** — 8 parallel probes per provider to saturate throughput
- **Standalone or extension** — runs as CLI script or as a pi slash command (`/bench`)

## Usage

### As a pi extension

Install into pi's extensions directory:

```bash
git clone https://github.com/fornace/pi-bench.git ~/.pi/agent/extensions/pi-bench
```

Then run inside pi:

```
/bench
```

Results are saved to `bench-results-v6.csv` in the extension directory.

### Standalone CLI

```bash
cd ~/.pi/agent/extensions/pi-bench
npx -y -p tsx tsx bench.mts
```

With custom output directory:

```bash
npx -y -p tsx tsx bench.mts --output-dir /tmp/bench-output
```

### Programmatic

```typescript
import { runBench, printTable } from "./bench.mts";

const { results, csvPath, stats } = await runBench({
  outputDir: "/tmp/bench",
  timeoutMs: 30000,
  concurrency: 8,
});

console.log(printTable(results));
console.log(`Probed ${stats.final} models → ${csvPath}`);
```

## Output

### CSV (`bench-results-v6.csv`)

| Column | Description |
|--------|-------------|
| rank | Position in latency ranking (ok models only) |
| id | Model ID |
| provider | Provider name (alibaba-cloud, google-vertex, etc.) |
| api | API type (anthropic-messages, google-vertex, etc.) |
| family | Model family tag (flash, turbo, plus, max, pro, etc.) |
| t_first_byte_ms | Time to first token in ms |
| t_complete_ms | Time to completion in ms |
| output_tokens | Tokens generated |
| cost_usd | Estimated cost in USD |
| status | ok / timeout / error:... / empty |
| quality | ok / multi-sentence / refusal / question / empty |
| sample | First 60 chars of response |

### Candidates file (`bench-candidates.txt`)

Lists all models that passed the filter, plus dropped models with reasons.

## Configuration

### Tunables (in `bench.mts`)

| Constant | Default | Description |
|----------|---------|-------------|
| `PER_CALL_TIMEOUT_MS` | 4000 | Max time per individual probe |
| `TOTAL_RUN_TIMEOUT_MS` | 30000 | Hard cap for the entire bench run |
| `CONCURRENCY_PER_PROVIDER` | 8 | Parallel probes per provider |
| `BATCH_GAP_MS` | 200 | Delay between probe batches |

### Filter

Models are filtered to text-capable candidates only. Blocklisted fragments: `embed`, `audio`, `tts`, `whisper`, `transcribe`, `dall-e`, `dalle`, `imagen`, `stable-diffusion`, `midjourney`, `moderation`, `guard`.

## Typical Results

```
RANK  FB      TOTAL   COST         FAMILY   PROVIDER           ID
1     349ms   589ms   ~$0          plus     alibaba-cloud      qwen-vl-plus
2     436ms   620ms   ~$0          plus     alibaba-cloud      qwen-plus-2025-09-11
3     421ms   679ms   ~$0          flash    alibaba-cloud      qwen-flash
4     427ms   717ms   ~$0          turbo    alibaba-cloud      qwen-turbo
5     488ms   719ms   ~$0          plus     alibaba-cloud      qwen-vl-plus-2025-05-07
```

Top models are typically Alibaba Cloud Qwen variants at sub-700ms latency and ~$0 cost.

## License

MIT
