export function playbackCapabilities(video, env = globalThis) {
  const canPlay = type => {
    try { return !!video?.canPlayType?.(type); } catch { return false; }
  };
  return {
    hls: canPlay('application/vnd.apple.mpegurl') || canPlay('application/x-mpegURL'),
    mse: typeof env.MediaSource !== 'undefined',
  };
}

export function deliverySources(movie, capabilities, key, clientId) {
  if (!movie?.url) return [];
  const auth = new URLSearchParams({ k: key });
  if (clientId) auth.set('c', clientId);
  const signed = url => `${url}?${auth}`;
  const direct = signed(movie.url);
  return capabilities?.hls && movie.hls ? [signed(movie.hls), direct] : [direct];
}
