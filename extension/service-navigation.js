// Keep a room destination through a profile/PIN gate without recreating the service document.
var WpServiceNavigation = {
  create({ here, signingIn, ready, navigate, failed = () => {}, now = Date.now, settleMs = 1500 }) {
    let target = '', stableAt = null, lastPage = '', attempted = false, attemptedAt = 0, reported = false;
    return {
      request(url) {
        if (url !== target) { target = url; stableAt = null; attempted = false; reported = false; lastPage = ''; }
      },
      tick() {
        if (!target) return;
        if (signingIn()) { stableAt = null; lastPage = ''; return; }
        if (ready(target)) { target = ''; return; }
        if (attempted && !reported && now() - attemptedAt >= 20000) { reported = true; failed(target); }
        const page = here();
        // /watch alone is not arrival: Netflix also shows PIN gates at that address.
        if (page === target) { stableAt = null; return; }
        if (page !== lastPage || stableAt === null) { lastPage = page; stableAt = now(); return; }
        if (attempted || now() - stableAt < settleMs) return;
        attempted = true; attemptedAt = now();
        navigate(target);
      },
      get pending() { return target; },
    };
  },
};
