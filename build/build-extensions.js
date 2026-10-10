'use strict';
const { buildChromium, buildSafari } = require('./build-safari-extension');
console.log('built', buildChromium());
console.log('built', buildSafari());
