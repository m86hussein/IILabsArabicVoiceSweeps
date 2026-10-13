#!/usr/bin/env node
/**
 * ElevenLabs Arabic TTS parameter sweep.
 *
 *   node src/sweep.js [--config sweep.config.json] [--dry-run] [--limit N]
 *
 * - Grid = models × stability × similarity × speed (from the config file)
 * - Credit guard: estimates credits and aborts if it exceeds the remaining quota
 * - Resumable: configs already in results.jsonl (without error) are skipped
 * - Output: runs/<runName>/{run.json, results.jsonl, audio/*.mp3, sweep.log}
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const API = "https://api.elevenlabs.io";
const ROOT = path.resolve(__dirname, "..");

// ── CLI / config ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { config: path.join(ROOT, "sweep.config.json"), dryRun: false, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") a.config = path.resolve(argv[++i]);
    else if (argv[i] === "--dry-run") a.dryRun = true;
    else if (argv[i] === "--limit") a.limit = parseInt(argv[++i], 10);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return a;
}

function loadApiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const file = process.env.ELEVENLABS_ENV_FILE
    || path.join(os.homedir(), ".config", "elevenlabs", "elevenlabs.env");
  if (!fs.existsSync(file)) return "";
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s]+)/);
    if (m) return m[1];
  }
  return "";
}

function buildConfigs(cfg) {
  const out = [];
  for (const m of cfg.models)
    for (const stability of cfg.grid.stability)
      for (const similarity of cfg.grid.similarity)
        for (const speed of cfg.grid.speed) {
          const short = m.id.replace("eleven_", "");
          out.push({
            id: `${short}-st${stability}-sm${similarity}-sp${speed ?? "def"}`,
            model: m.id, multiplier: m.creditMultiplier ?? 1,
            stability, similarity, speed, style: cfg.grid.style ?? 0,
          });
        }
  return out;
}

// ── Run directory / resume ──────────────────────────────────────────────────
function readResults(file) {
  const byId = new Map();
  if (!fs.existsSync(file)) return byId;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    byId.set(r.id, r); // last line per id wins
  }
  return byId;
}

// ── ElevenLabs API ──────────────────────────────────────────────────────────
async function api(key, method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-JSON body */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function getRemainingCredits(key) {
  const r = await api(key, "GET", "/v1/user/subscription");
  if (!r.ok) throw new Error(`Subscription lookup failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  const s = r.json;
  return { tier: s.tier, used: s.character_count, limit: s.character_limit,
    remaining: s.character_limit - s.character_count, resetUnix: s.next_character_count_reset_unix };
}

/** Returns a voice_id usable by this account, adding the library voice if needed. */
async function ensureVoice(key, voice) {
  const own = await api(key, "GET", `/v1/voices/${voice.id}`);
  if (own.ok) return voice.id;

  const list = await api(key, "GET", "/v1/voices");
  const found = list.ok && (list.json.voices || []).find(v => v.name === voice.name);
  if (found) return found.voice_id;

  if (!voice.publicOwnerId) throw new Error(`Voice ${voice.id} is not on this account and no publicOwnerId is configured`);
  const add = await api(key, "POST", `/v1/voices/add/${voice.publicOwnerId}/${voice.id}`, { new_name: voice.name });
  if (!add.ok) throw new Error(`Adding library voice failed: HTTP ${add.status} ${add.text.slice(0, 300)}`);
  console.log(`Added library voice "${voice.name}" to the account → ${add.json.voice_id}`);
  return add.json.voice_id;
}

async function generateTTS(key, voiceId, text, cfg, conf) {
  const voice_settings = {
    stability: cfg.stability, similarity_boost: cfg.similarity,
    style: cfg.style, use_speaker_boost: true,
  };
  if (cfg.speed !== null) voice_settings.speed = cfg.speed;
  const body = {
    text, model_id: cfg.model, language_code: conf.languageCode, seed: conf.seed,
    apply_text_normalization: "on", voice_settings,
  };
  const url = `${API}/v1/text-to-speech/${voiceId}?output_format=${conf.outputFormat}`;

  // Capped retry with backoff for 429 (concurrency / rate limit) only.
  for (let attempt = 1; ; attempt++) {
    const start = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify(body), signal: ctrl.signal,
      });
      const genTimeMs = Date.now() - start;
      if (res.status === 429 && attempt < 4) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return { error: `HTTP ${res.status}: ${errText.slice(0, 300)}`, status: res.status, genTimeMs };
      }
      const cost = res.headers.get("character-cost") ?? res.headers.get("x-character-count");
      return {
        audio: Buffer.from(await res.arrayBuffer()), genTimeMs,
        creditsCharged: cost !== null ? Number(cost) : null,
        requestId: res.headers.get("request-id"),
      };
    } catch (err) {
      return { error: err.message, genTimeMs: Date.now() - start };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Audio analysis (ffmpeg) ─────────────────────────────────────────────────
function ffmpeg(args) {
  const ffmpegPath = require("ffmpeg-static");
  const r = spawnSync(ffmpegPath, ["-hide_banner", "-nostats", ...args, "-f", "null", "-"], { encoding: "utf8" });
  return r.stderr || "";
}

function analyzeAudio(file, text) {
  const probe = ffmpeg(["-i", file]);
  const d = probe.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const duration = d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0;

  const nSegs = 5, segDur = duration / nSegs, segVols = [];
  for (let i = 0; i < nSegs && segDur > 0; i++) {
    const out = ffmpeg(["-ss", (i * segDur).toFixed(2), "-t", segDur.toFixed(2), "-i", file, "-af", "volumedetect"]);
    const m = out.match(/mean_volume:\s*([-\d.]+)/);
    if (m) segVols.push(parseFloat(m[1]));
  }

  const pauses = [];
  const sil = ffmpeg(["-i", file, "-af", "silencedetect=n=-35dB:d=0.2"]);
  for (const m of sil.matchAll(/silence_duration:\s*([\d.]+)/g)) pauses.push(parseFloat(m[1]));

  const rd = v => Math.round(v * 10) / 10;
  const rd2 = v => Math.round(v * 100) / 100;
  const pauseTotal = pauses.reduce((a, b) => a + b, 0);
  const speechDur = duration - pauseTotal;
  const words = text.trim().split(/\s+/).length;
  return {
    durationSec: rd(duration), speechDurSec: rd(speechDur),
    segVols: segVols.map(rd),
    volSpreadDb: rd(segVols.length ? Math.max(...segVols) - Math.min(...segVols) : 0),
    volMeanDb: rd(segVols.length ? segVols.reduce((a, b) => a + b, 0) / segVols.length : 0),
    pauseCount: pauses.length, pauseTotalSec: rd(pauseTotal),
    pauseMaxSec: pauses.length ? rd2(Math.max(...pauses)) : 0,
    pauseAvgSec: pauses.length ? rd2(pauseTotal / pauses.length) : 0,
    charsPerSec: rd(speechDur > 0 ? text.length / speechDur : 0),
    wordsPerSec: rd(speechDur > 0 ? words / speechDur : 0),
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const conf = JSON.parse(fs.readFileSync(args.config, "utf8"));
  const text = conf.text.replace(/[*#]/g, "").trim();

  const runDir = path.join(ROOT, "runs", conf.runName);
  const audioDir = path.join(runDir, "audio");
  const resultsFile = path.join(runDir, "results.jsonl");
  const logFile = path.join(runDir, "sweep.log");

  const all = buildConfigs(conf);
  const previous = readResults(resultsFile);
  const todo = all.filter(c => !(previous.get(c.id) && !previous.get(c.id).error)).slice(0, args.limit);
  const estimate = todo.reduce((s, c) => s + Math.ceil(text.length * c.multiplier), 0);

  console.log(`Run      : ${conf.runName}`);
  console.log(`Voice    : ${conf.voice.name} (${conf.voice.id})`);
  console.log(`Text     : ${text.length} chars, ${text.split(/\s+/).length} words`);
  console.log(`Grid     : ${conf.models.length} models × ${conf.grid.stability.length} stab × ${conf.grid.similarity.length} sim × ${conf.grid.speed.length} speed = ${all.length}`);
  console.log(`To run   : ${todo.length} (${all.length - todo.length} already done)`);
  for (const m of conf.models) {
    const n = todo.filter(c => c.model === m.id).length;
    console.log(`  ${m.id.padEnd(26)} ${String(n).padStart(3)} × ${text.length} × ${m.creditMultiplier ?? 1} = ${Math.ceil(n * text.length * (m.creditMultiplier ?? 1))} credits`);
  }
  console.log(`Estimate : ${estimate} credits`);

  const key = loadApiKey();
  if (!key) {
    if (args.dryRun) return;
    throw new Error("No API key. Set ELEVENLABS_API_KEY or ELEVENLABS_ENV_FILE (default ~/.config/elevenlabs/elevenlabs.env)");
  }

  const credits = await getRemainingCredits(key);
  const reserve = conf.budget?.reserveCredits ?? 0;
  console.log(`Account  : ${credits.tier} tier, ${credits.used}/${credits.limit} used, ${credits.remaining} remaining (reserve ${reserve})`);
  if (estimate > credits.remaining - reserve) {
    throw new Error(`Budget guard: needs ${estimate} credits but only ${credits.remaining - reserve} are spendable. Shrink the grid/text or use --limit.`);
  }
  if (args.dryRun || todo.length === 0) {
    console.log(args.dryRun ? "\nDry run — nothing generated." : "\nAll configs already done.");
    return;
  }

  const voiceId = await ensureVoice(key, conf.voice);
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({
    runName: conf.runName, voice: { ...conf.voice, accountVoiceId: voiceId }, text,
    models: conf.models, grid: conf.grid, languageCode: conf.languageCode, seed: conf.seed,
    outputFormat: conf.outputFormat, startedAt: new Date().toISOString(),
  }, null, 2));
  const log = msg => fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  log(`Start: ${todo.length} configs, estimate ${estimate} credits, remaining ${credits.remaining}`);

  let next = 0, ok = 0, fail = 0, stop = null;
  const started = Date.now();

  async function worker(w) {
    while (!stop && next < todo.length) {
      const cfg = todo[next++];
      const label = `${cfg.id}`;
      const g = await generateTTS(key, voiceId, text, cfg, conf);
      const base = {
        id: cfg.id, run: conf.runName, model: cfg.model,
        stability: cfg.stability, similarity: cfg.similarity, speed: cfg.speed, style: cfg.style,
        voiceId, textChars: text.length, textWords: text.split(/\s+/).length,
        genTimeMs: g.genTimeMs, timestamp: new Date().toISOString(),
      };
      if (g.error) {
        fail++;
        fs.appendFileSync(resultsFile, JSON.stringify({ ...base, error: g.error }) + "\n");
        log(`FAIL ${label}: ${g.error}`);
        console.log(`[W${w}] ${label.padEnd(36)} FAIL ${g.error.slice(0, 120)}`);
        // Account-level problems: stop everything instead of burning through the grid.
        if ([401, 402, 403].includes(g.status) || /quota|payment|subscription/i.test(g.error)) stop = g.error;
        continue;
      }
      const audioFile = `audio/${cfg.id}.mp3`;
      const abs = path.join(runDir, audioFile);
      fs.writeFileSync(abs, g.audio);
      const a = analyzeAudio(abs, text);
      const rec = { ...base, fileSizeBytes: g.audio.length, creditsCharged: g.creditsCharged,
        requestId: g.requestId, audioFile, ...a };
      fs.appendFileSync(resultsFile, JSON.stringify(rec) + "\n");
      ok++;
      log(`OK ${label}: ${a.durationSec}s ${a.charsPerSec}c/s volΔ=${a.volSpreadDb}dB ${a.pauseCount}p gen=${g.genTimeMs}ms credits=${g.creditsCharged}`);
      console.log(`[W${w}] ${label.padEnd(36)} ${a.durationSec}s | ${a.charsPerSec} c/s | volΔ ${a.volSpreadDb}dB | ${a.pauseCount}p | ${g.genTimeMs}ms | credits ${g.creditsCharged ?? "?"}`);
    }
  }

  await Promise.all(Array.from({ length: conf.concurrency || 2 }, (_, i) => worker(i + 1)));
  const after = await getRemainingCredits(key);
  const spent = credits.remaining - after.remaining;
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  log(`Done: ${ok} ok, ${fail} failed in ${secs}s, spent ${spent} credits${stop ? `, stopped: ${stop}` : ""}`);
  console.log(`\nDone: ${ok} ok, ${fail} failed in ${secs}s · spent ${spent} credits (estimate ${estimate}) · ${after.remaining} remaining`);
  if (stop) console.log(`Stopped early: ${stop}`);
  console.log(`Results: ${path.relative(ROOT, resultsFile)}\nReport : npm run report -- runs/${conf.runName}`);
  if (stop) process.exitCode = 1;
}

main().catch(err => { console.error(`\n${err.message}`); process.exit(1); });
