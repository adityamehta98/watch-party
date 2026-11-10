// The browser downloads store updates. No executable code is fetched from a party server.
var WPExtensionUpdate = (() => {
  const AVAILABLE = 'wp.update.available', READY = 'wp.update.ready', RELOAD = 'wp.update.reload';
  const valid = value => typeof value === 'string' && /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(value);
  function atLeast(version, required) {
    if (!valid(version) || !valid(required)) return false;
    const a = version.split('.').map(Number), b = required.split('.').map(Number);
    for (let i = 0; i < 4; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    return true;
  }
  function create(api, { request = globalThis.fetch, later = setTimeout } = {}) {
    const session = api.storage?.session;
    let checking = null, checkingTarget = '', checkingPassive = false, applying = null;
    api.runtime.onUpdateAvailable?.addListener(details => {
      if (session && valid(details.version)) session.set({ [AVAILABLE]: details.version }).catch(() => {});
    });
    async function check(required, { passive = false } = {}) {
      if (!session || !valid(required)) return { status: 'error', error: 'This browser cannot check extension updates.' };
      if (checking) {
        if (checkingTarget === required && (passive || !checkingPassive)) return checking;
        await checking;
        return check(required, { passive });
      }
      checkingTarget = required; checkingPassive = passive;
      checking = (async () => {
        await session.remove(READY);
        const self = await api.management.getSelf(); // getSelf needs no management permission
        let version = self.version;
        if (passive && atLeast(version, required)) return { status: 'current', version };
        if (!atLeast(version, required)) {
          if (self.installType === 'development') {
            // The host app updates its bundled folder in place. An unpacked guest copy
            // still needs new files locally; never pretend a reload downloaded them.
            const manifest = await request(api.runtime.getURL('manifest.json'), { cache: 'no-store' }).then(r => r.json());
            version = manifest.version;
            if (!atLeast(version, required)) {
              const managed = await request(api.runtime.getURL('watch-party-managed.json'), { cache: 'no-store' })
                .then(r => r.ok ? r.json() : null).catch(() => null);
              return { status: managed?.schema === 1 ? 'native' : 'manual' };
            }
          } else {
            version = (await session.get(AVAILABLE))[AVAILABLE];
            if (!atLeast(version, required)) {
              if (passive) return { status: 'outdated' };
              const result = await api.runtime.requestUpdateCheck();
              if (result.status !== 'update_available') return { status: result.status === 'throttled' ? 'throttled' : 'no_update' };
              version = result.version;
            }
            if (!atLeast(version, required)) return { status: 'no_update' };
          }
        }
        await session.set({ [READY]: { version } });
        return { status: 'ready', version };
      })().catch(() => ({ status: 'error', error: 'Could not check for an update. Please try again.' }));
      try { return await checking; } finally { checking = null; }
    }
    async function apply(tabIds) {
      if (applying) return applying;
      applying = (async () => {
        const ready = session && (await session.get(READY))[READY];
        if (!valid(ready?.version)) return { status: 'error', error: 'Check for an update first.' };
        const tabs = [...new Set(tabIds.filter(id => Number.isInteger(id) && id >= 0))];
        // storage.session is cleared by an extension reload. Only this short-lived
        // restart marker belongs in local storage; no URLs or room keys are retained.
        await api.storage.local.set({ [RELOAD]: { tabs, at: Date.now() } });
        await session.remove(READY);
        later(() => api.runtime.reload(), 150); // let the reply reach the page before its bridge disconnects
        return { status: 'reloading' };
      })();
      try {
        const result = await applying;
        if (result.status !== 'reloading') applying = null;
        return result;
      } catch (error) { applying = null; throw error; }
    }
    async function restore() {
      const local = api.storage?.local;
      if (!local) return;
      const marker = (await local.get(RELOAD))[RELOAD];
      if (!marker) return;
      await local.remove(RELOAD); // consume once, even if a tab was closed during the update
      if (!Array.isArray(marker.tabs) || !Number.isFinite(marker.at) || Date.now() - marker.at > 30000 || marker.at > Date.now()) return;
      await Promise.all(marker.tabs.filter(id => Number.isInteger(id) && id >= 0).map(id => api.tabs.reload(id).catch(() => {})));
    }
    return { check, apply, restore };
  }
  return { create, atLeast };
})();
if (typeof module !== 'undefined') module.exports = WPExtensionUpdate;
