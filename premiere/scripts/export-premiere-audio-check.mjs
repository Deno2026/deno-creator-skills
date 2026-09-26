// Export the active Premiere sequence's audio (WAV by default) for loudness verification, via the UXP `export_sequence` tool.
//   node scripts/export-premiere-audio-check.mjs --out tmp/<slug>-audio/mix-check-01.wav [--preset wav|aac] [--timeout-ms 900000]
// Then measure: node scripts/verify-program-loudness.mjs <wav> ... (see audio-finishing.md §3 step 7).
// Preset paths must be Windows backslash paths passed through JSON.stringify (forward slashes are rejected by the host).
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.cwd();
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); if (i >= 0) return process.argv[i + 1]; const e = process.argv.find((a) => a.startsWith(`--${k}=`)); return e ? e.slice(k.length + 3) : d; };
const out = arg('out');
if (!out) throw new Error('--out <file> is required (e.g. tmp/<slug>-audio/mix-check-01.wav)');
const presetKey = arg('preset', 'wav');
const timeoutMs = Number(arg('timeout-ms', 900000));
// 프리미어 설치 폴더: PREMIERE_APP_ROOT 또는 C:/Program Files/Adobe/Adobe Premiere Pro <가장 최신 판>
function premiereAppRoot() {
  if (process.env.PREMIERE_APP_ROOT) return process.env.PREMIERE_APP_ROOT.replace(/\\/g, '/').replace(/\/$/, '');
  const adobe = 'C:/Program Files/Adobe';
  const found = (fs.existsSync(adobe) ? fs.readdirSync(adobe) : [])
    .filter((name) => /^Adobe Premiere Pro/i.test(name))
    .sort((a, b) => (b.match(/\d+/)?.[0] ?? 0) - (a.match(/\d+/)?.[0] ?? 0));
  if (!found.length) throw new Error(`Premiere Pro install not found under ${adobe}; set PREMIERE_APP_ROOT`);
  return `${adobe}/${found[0]}`;
}
const base = `${premiereAppRoot()}/MediaIO/systempresets/`;
const presets = {
  wav: base + '3F3F3F3F_57415645/Waveform Audio 48kHz 16-bit.epr',
  aac: base + '4E49434B_41414320/Stereo AAC, 48kHz 256kbps.epr',
};
const preset = presets[presetKey];
if (!preset) throw new Error(`unknown --preset ${presetKey}; use ${Object.keys(presets).join('|')}`);
if (!fs.existsSync(preset)) throw new Error(`preset not installed: ${preset}`);

const w = (p) => path.win32.normalize(p);
const output = w(path.resolve(repo, out));
fs.mkdirSync(path.dirname(output), {recursive: true});
if (fs.existsSync(output)) throw new Error(`refusing to overwrite ${output}; pick a new name so each measurement stays traceable`);
const request = {output_path: output, preset_path: w(preset), work_area_only: false, destination: 'immediate'};
const started = Date.now();
const r = spawnSync(process.execPath, [path.join(repo, 'servers/premiere-uxp-mcp/call-tool.mjs'), 'export_sequence', JSON.stringify(request), '--allow-write', '--allow-dangerous', '--timeout-ms', String(timeoutMs)],
  {cwd: repo, encoding: 'utf8', windowsHide: true, timeout: timeoutMs + 20000, maxBuffer: 8 * 1024 * 1024});
const tail = ((r.stdout || '') + (r.stderr || '')).split('\n').filter((l) => l.trim() && !l.startsWith('[')).slice(-4).join(' | ');
const ok = fs.existsSync(output) && fs.statSync(output).size > 0;
console.log(JSON.stringify({ok, output, bytes: ok ? fs.statSync(output).size : 0, seconds: Math.round((Date.now() - started) / 1000), preset: presetKey, exitCode: r.status, tail: tail.slice(0, 400)}, null, 2));
if (!ok) process.exitCode = 1;
