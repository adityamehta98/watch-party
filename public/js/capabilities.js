// `platform` comes from platform.js; it is passed in so this module stays dependency-free.
export function playbackCapabilities(video, env = globalThis, platform = {}) {
  const canPlay = type => {
    try { return !!video?.canPlayType?.(type); } catch { return false; }
  };
  return {
    hls: canPlay('application/vnd.apple.mpegurl') || canPlay('application/x-mpegURL'),
    mse: typeof env.MediaSource !== 'undefined' || typeof env.ManagedMediaSource !== 'undefined',
    nativeHlsPreferred: !!(platform.safari || platform.appleMobile),
  };
}

export function deliverySources(movie, capabilities, key, clientId) {
  if (!movie) return [];
  const auth = new URLSearchParams({ k: key });
  if (clientId) auth.set('c', clientId);
  const signed = url => `${url}?${auth}`;
  const sources = [];
  if (movie.url) sources.push({ type: 'direct', url: signed(movie.url) });
  if (movie.hls) {
    // Only Safari's native HLS is trusted (Chrome's fails on growing playlists).
    const appleNative = capabilities?.hls && capabilities.nativeHlsPreferred;

    const remoteHls = movie.kind === 'anime' || movie.kind === 'catalog';
    let types;
    if (appleNative && !(capabilities?.mse && remoteHls)) types = ['native-hls', ...(capabilities.mse ? ['hls-js'] : [])];
    else if (capabilities?.mse) types = ['hls-js', ...(appleNative ? ['native-hls'] : [])];
    else types = capabilities?.hls ? ['native-hls'] : [];
    const hls = types.map(type => ({ type, url: signed(movie.hls) }));
    // Completed movies keep the faster ranged MP4 first; HLS-only (growing or anime) leads.
    if (!movie.url || movie.progressive) sources.unshift(...hls);
    else sources.push(...hls);
  }
  return sources;
}

const sameSource = (a, b) => !!a && !!b && a.type === b.type && a.url === b.url;

export function reconcileDeliverySources(nextSources, activeSource, failed = false) {
  const sources = [...(nextSources || [])];
  const activeAt = sources.findIndex(source => sameSource(source, activeSource));
  if (activeAt >= 0 && !failed) {
    const [active] = sources.splice(activeAt, 1);
    return { sources: [active, ...sources], activate: null };
  }
  if (activeAt >= 0) sources.push(...sources.splice(activeAt, 1));
  return { sources, activate: sources[0] || null };
}
