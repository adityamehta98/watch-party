let hlsLoader = null;

function loadHls() {
  if (globalThis.Hls) return Promise.resolve(globalThis.Hls);
  if (hlsLoader) return hlsLoader;
  hlsLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/hls.min.js';
    script.async = true;
    script.onload = () => globalThis.Hls ? resolve(globalThis.Hls) : reject(new Error('HLS player did not load'));
    script.onerror = () => reject(new Error('HLS player could not be loaded'));
    document.head.appendChild(script);
  }).catch(error => { hlsLoader = null; throw error; });
  return hlsLoader;
}

export class FilePlayback {
  constructor(video, { loader = loadHls, onReady = () => {}, onFatal = () => {} } = {}) {
    this.video = video;
    this.loader = loader;
    this.onReady = onReady;
    this.onFatal = onFatal;
    this.hls = null;
    this.mode = 'none';
    this.source = null;
    this.generation = 0;
    this.ready = false;
    this.networkRetries = 0;
    this.mediaRecoveries = 0;
  }

  get ownsErrors() { return this.mode === 'hls-js'; }

  destroyHls() {
    if (!this.hls) return;
    try { this.hls.destroy(); } catch {}
    this.hls = null;
  }

  close(clear = true) {
    this.generation++;
    this.destroyHls();
    this.mode = 'none';
    this.source = null;
    this.ready = false;
    if (!clear) return;
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch {}
  }

  async open(source, startAt = 0) {
    if (!source?.url || !['direct', 'native-hls', 'hls-js'].includes(source.type)) throw new Error('Invalid movie source');
    const generation = ++this.generation;
    this.destroyHls();
    this.mode = source.type;
    this.source = source;
    this.ready = false;
    this.networkRetries = 0;
    this.mediaRecoveries = 0;

    if (source.type !== 'hls-js') {
      this.video.src = source.url;
      this.video.preload = 'auto';
      this.video.load();
      return;
    }

    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    const Hls = await this.loader();
    if (generation !== this.generation) return;
    if (!Hls?.isSupported?.()) throw new Error('This browser cannot play the streaming copy');

    const hls = new Hls({
      autoStartLoad: false,

      lowLatencyMode: false,

      maxBufferLength: 90,
      maxMaxBufferLength: 600,
      maxBufferSize: 240 * 1000 * 1000,
      maxBufferHole: 0.5,
      backBufferLength: 90,
      enableWorker: true,
    });
    this.hls = hls;
    const fail = data => {
      if (generation !== this.generation) return;
      this.destroyHls();
      this.onFatal(new Error(data?.details || 'The streaming copy could not be played'), source);
    };
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      if (generation === this.generation) hls.loadSource(source.url);
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (generation === this.generation) hls.startLoad(Math.max(0, Number(startAt) || 0));
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (generation !== this.generation || this.ready) return;
      this.ready = true;
      this.onReady(source);
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (generation !== this.generation || !data?.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.networkRetries++ < 2) {
        hls.startLoad(Math.max(0, Number(this.video.currentTime) || Number(startAt) || 0));
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.mediaRecoveries++ < 1) {
        hls.recoverMediaError();
      } else fail(data);
    });
    hls.attachMedia(this.video);
  }
}

