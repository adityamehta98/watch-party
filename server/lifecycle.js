'use strict';

// A lost socket is not a closed player window. Only an explicit page departure
// starts the close grace period; background tabs and reconnects never expire.
class PlayerLifecycle {
  constructor({ now = Date.now, closeGraceMs = 15000 } = {}) {
    Object.assign(this, { now, closeGraceMs });
    this.windows = new Map();
    this.closeAt = null;
  }

  window({ id, action, sequence }) {
    if (!/^[a-z0-9]{12,64}$/.test(id || '') || !['open', 'close', 'activity'].includes(action) ||
        !Number.isSafeInteger(sequence) || sequence < 1) return false;
    const previous = this.windows.get(id);
    if (previous && sequence <= previous.sequence) return true;
    if (!previous && this.windows.size >= 1000) return false;
    this.windows.set(id, { sequence, open: action !== 'close' });
    if ([...this.windows.values()].some(window => window.open)) this.closeAt = null;
    else this.closeAt = this.now() + this.closeGraceMs;
    return true;
  }

  playerClosed() { return this.closeAt !== null && this.now() >= this.closeAt; }
}

module.exports = { PlayerLifecycle };
