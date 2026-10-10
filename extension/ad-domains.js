// Ad, pop-up and pop-under networks, blocked on custom sites in the Watch Party window (see background.js).
// Each entry also blocks its subdomains. Only custom sites are affected; Netflix & co are left alone.
const WP_AD_DOMAINS = [
  // big ad exchanges and trackers
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'googletagservices.com', 'adservice.google.com',
  'pagead2.googlesyndication.com', 'adnxs.com', 'adsrvr.org', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
  'amazon-adsystem.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'casalemedia.com', 'smartadserver.com',
  'yieldmo.com', 'media.net', 'adform.net', 'moatads.com', 'scorecardresearch.com', 'quantserve.com', 'zedo.com',
  'revcontent.com', 'mgid.com', 'adblade.com', 'contextweb.com', 'bidswitch.net', 'sharethrough.com', 'teads.tv',
  // pop-up / pop-under / redirect networks common on free video sites
  'popads.net', 'popcash.net', 'propellerads.com', 'propellerclick.com', 'onclickads.net', 'onclkds.com', 'onclickmax.com',
  'adsterra.com', 'adsterratech.com', 'highperformanceformat.com', 'profitablegatecpm.com', 'effectiveratecpm.com',
  'exoclick.com', 'exosrv.com', 'exdynsrv.com', 'juicyads.com', 'trafficjunky.net', 'trafficjunky.com', 'trafficstars.com',
  'hilltopads.net', 'hilltopads.com', 'clickadu.com', 'adcash.com', 'admaven.com', 'ad-maven.com', 'a-ads.com',
  'zeropark.com', 'monetag.com', 'galaksion.com', 'clickaine.com', 'adspyglass.com', 'popmyads.com', 'poptm.com',
  'adxpansion.com', 'richads.com', 'pushground.com', 'evadav.com', 'rollerads.com', 'dolohen.com', 'clickadilla.com',
  'adskeeper.com', 'adskeeper.co.uk', 'bidvertiser.com', 'infolinks.com', 'yllix.com', 'vidoomy.com', 'adtng.com',
  'realsrv.com', 'tsyndicate.com', 'ad.plus', 'aclib.net', 'acint.net', 'mobmoney.co', 'pemsrv.com', 'whos.amung.us',
];
if (typeof self !== 'undefined') self.WP_AD_DOMAINS = WP_AD_DOMAINS;
