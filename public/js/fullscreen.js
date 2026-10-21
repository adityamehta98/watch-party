// Fullscreen belongs to the stage so controls, captions and chat stay with the video.
export class StageFullscreen {
  constructor(stage, onChange = () => {}, { onUnavailable = () => {} } = {}) {
    this.stage = stage;
    this.document = stage.ownerDocument;
    this.onChange = onChange;
    this.onUnavailable = onUnavailable;
    this.pending = false;
    this.document.addEventListener('fullscreenchange', () => this.update());
    this.document.addEventListener('webkitfullscreenchange', () => this.update());
    this.document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.pageMode) this.toggle();
    });
  }

  get pageMode() { return this.stage.classList.contains('page-fullscreen'); }
  get active() {
    return this.pageMode || this.document.fullscreenElement === this.stage || this.document.webkitFullscreenElement === this.stage;
  }

  update() {
    this.stage.classList.toggle('is-fs', this.active);
    this.onChange(this.active);
  }

  expandPage() {
    this.stage.classList.add('page-fullscreen');
    this.update();
  }

  nativeEnabled() {
    // Brave can override document.fullscreenEnabled and requestFullscreen with a
    // video-only shim. Read the browser's prototype getter to bypass that claim.
    const prototype = this.document.defaultView?.Document?.prototype;
    if (!prototype) return true;
    for (const name of ['fullscreenEnabled', 'webkitFullscreenEnabled']) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor?.get && descriptor.get.call(this.document)) return true;
    }
    return false;
  }

  enter(request) {
    // The prefixed WebKit API returns void and finishes its transition later.
    return new Promise(resolve => {
      const finish = success => {
        clearTimeout(timer);
        this.document.removeEventListener('fullscreenchange', changed);
        this.document.removeEventListener('webkitfullscreenchange', changed);
        resolve(success);
      };
      const changed = () => { if (this.active) finish(true); };
      const timer = setTimeout(() => finish(false), 1500);
      this.document.addEventListener('fullscreenchange', changed);
      this.document.addEventListener('webkitfullscreenchange', changed);
      try {
        Promise.resolve(request.call(this.stage)).then(changed, () => finish(false));
      } catch { finish(false); }
    });
  }

  async toggle() {
    if (this.pending) return;
    if (this.pageMode) {
      this.stage.classList.remove('page-fullscreen');
      this.update();
      return;
    }
    this.pending = true;
    try {
      if (this.active) {
        const exit = this.document.exitFullscreen || this.document.webkitExitFullscreen;
        await exit.call(this.document);
      } else {
        // Prefer WebKit's element API over an injected requestFullscreen shim.
        const request = this.stage.webkitRequestFullscreen || this.stage.requestFullscreen;
        try {
          if (!request || !this.nativeEnabled()) throw new Error('Element fullscreen unavailable');
          const entered = await this.enter(request);
          // A successful return from a shim does not mean the stage is fullscreen.
          if (!entered) throw new Error('Stage did not enter fullscreen');
        } catch {
          this.onUnavailable();
        }
      }
    } finally {
      this.pending = false;
      this.update();
    }
  }
}
