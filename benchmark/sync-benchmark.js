'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(__dirname, 'results.json');
const BADGE = path.join(ROOT, '.github', 'badges', 'sync.svg');
const SEED = 0x5eedc0de;
const PROFILES = [
  { name: 'wired desktop', viewers: 2, rtt: 28, jitter: 6, buffer: 14, stallRate: 0.0004 },
  { name: 'Wi-Fi laptop', viewers: 2, rtt: 85, jitter: 22, buffer: 8, stallRate: 0.002 },
  { name: 'Wi-Fi iPad', viewers: 2, rtt: 110, jitter: 30, buffer: 6, stallRate: 0.003, apple: true },
  { name: 'mobile iPhone', viewers: 2, rtt: 180, jitter: 65, buffer: 4, stallRate: 0.006, apple: true },
];

function random(seed = SEED) {
  let state = seed >>> 0, spare = null;
  const uniform = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  uniform.normal = () => {
    if (spare != null) { const value = spare; spare = null; return value; }
    const mag = Math.sqrt(-2 * Math.log(Math.max(uniform(), 1e-12))), angle = 2 * Math.PI * uniform();
    spare = mag * Math.sin(angle);
    return mag * Math.cos(angle);
  };
  return uniform;
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];

async function loadTuning() {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'sync.js'), 'utf8');
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).syncTuning;
}

async function run() {
  const syncTuning = await loadTuning(), rng = random(), errors = [], byProfile = {};
  const dt = 0.2, duration = 360, warmup = 10, trials = 12;
  for (let trial = 0; trial < trials; trial++) {
    const clients = PROFILES.flatMap(profile => Array.from({ length: profile.viewers }, () => ({
      profile, drift: rng.normal() * 0.28, ema: 0, clockError: 0, rate: 1,
      oscillator: rng.normal() * 0.00012, buffer: profile.buffer, stalledFor: 0,
      sinceSeek: 99, sinceNudge: 99,
    })));
    for (let elapsed = 0; elapsed < duration; elapsed += dt) {
      for (const client of clients) {
        const p = client.profile;
        client.clockError = client.clockError * 0.82 + rng.normal() * p.jitter / 1000 * 0.18;
        if (client.stalledFor <= 0 && rng() < p.stallRate * dt) client.stalledFor = 0.4 + rng() * 2.2;
        if (client.stalledFor > 0) {
          client.stalledFor -= dt;
          client.drift -= dt;
          client.rate = 0;
          client.buffer = 0;
        } else {
          client.buffer = Math.min(p.buffer, client.buffer + dt * (p.apple ? 1.2 : 1.8));
          client.drift += (client.rate - 1 + client.oscillator) * dt;
          const measured = client.drift - client.clockError;
          client.ema = Math.abs(measured - client.ema) > 0.5 ? measured : client.ema * 0.65 + measured * 0.35;
          const browserProfile = p.apple ? { hardSeek: 0.35, rate: false, nudge: 0.08 } : {};
          const tuning = syncTuning({ drift: client.ema, ahead: client.buffer, rtt: p.rtt, profile: browserProfile });
          if (Math.abs(measured) > tuning.hardSeek && client.sinceSeek > 3) {
            client.drift = rng.normal() * (0.008 + p.jitter / 4000);
            client.ema = 0;
            client.rate = 1;
            client.sinceSeek = 0;
          } else if (p.apple) {
            client.rate = 1;
            if (Math.abs(measured) > browserProfile.nudge && client.buffer >= 2 && client.sinceNudge > 4) {
              client.drift = rng.normal() * (0.012 + p.jitter / 3000);
              client.ema = 0;
              client.sinceNudge = 0;
            }
          } else if (client.buffer >= 0.4 && Math.abs(client.ema) > tuning.softEps) {
            client.rate = 1 - Math.max(-tuning.maxRateDelta, Math.min(tuning.maxRateDelta, client.ema * 0.8));
          } else client.rate = 1;
        }
        client.sinceSeek += dt;
        client.sinceNudge += dt;
        if (elapsed >= warmup) {
          const error = Math.round(Math.abs(client.drift + rng.normal() * (p.apple ? 0.006 : 0.002)) * 1000);
          errors.push(error);
          (byProfile[p.name] ||= []).push(error);
        }
      }
    }
  }
  errors.sort((a, b) => a - b);
  const summarize = values => {
    values.sort((a, b) => a - b);
    return { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99), maxMs: values.at(-1) };
  };
  return {
    schema: 1,
    method: 'deterministic controller simulation',
    seed: `0x${SEED.toString(16)}`,
    tickMs: dt * 1000,
    simulatedMinutes: duration * trials / 60,
    viewersPerTrial: PROFILES.reduce((sum, profile) => sum + profile.viewers, 0),
    samples: errors.length,
    ...summarize(errors),
    profiles: Object.fromEntries(Object.entries(byProfile).map(([name, values]) => [name, summarize(values)])),
  };
}

function badge(result) {
  const label = `p50 ${result.p50Ms} ms | p95 ${result.p95Ms} ms`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="245" height="20" role="img" aria-label="sync error: ${label}"><title>sync error: ${label}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-opacity=".12"/></linearGradient><clipPath id="r"><rect width="245" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><path fill="#555" d="M0 0h78v20H0z"/><path fill="#2f9e68" d="M78 0h167v20H78z"/><path fill="url(#s)" d="M0 0h245v20H0z"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11"><text x="39" y="15" fill="#010101" fill-opacity=".3">sync error</text><text x="39" y="14">sync error</text><text x="161.5" y="15" fill="#010101" fill-opacity=".3">${label}</text><text x="161.5" y="14">${label}</text></g></svg>\n`;
}

async function main() {
  const result = await run();
  const json = `${JSON.stringify(result, null, 2)}\n`, svg = badge(result);
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(BADGE), { recursive: true });
    fs.writeFileSync(RESULTS, json);
    fs.writeFileSync(BADGE, svg);
  } else if (process.argv.includes('--check')) {
    if (fs.readFileSync(RESULTS, 'utf8') !== json || fs.readFileSync(BADGE, 'utf8') !== svg) throw new Error('benchmark artifacts are stale; run npm run benchmark:sync');
  }
  process.stdout.write(json);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { badge, random, run };
