const HARD_SEEK = 0.9;
const SOFT_EPS = 0.03;
const MAX_RATE_DELTA = 0.06;

// Keep Apple's media clock at its normal rate. Repeated rate changes can interrupt
// HLS decoding; tolerate small drift and only correct sustained, substantial gaps.
export const APPLE_PROFILE = { hardSeek: 1.5, rate: false, pausedEps: 0.2, driftHold: 2000, seekCooldown: 10000 };

export function syncTuning({ drift = 0, ahead = null, rtt = 0, profile = {} } = {}) {
  const lowBuffer = ahead != null && ahead < 2;
  return {
    hardSeek: (profile.hardSeek || HARD_SEEK) + (lowBuffer ? 0.25 : 0),
    softEps: Math.max(profile.softEps || SOFT_EPS, Math.min(0.08, Math.max(0, rtt) / 10000)),
    maxRateDelta: lowBuffer && drift < 0 ? 0.025 : Math.abs(drift) > 0.12 ? 0.1 : MAX_RATE_DELTA,
  };
}
