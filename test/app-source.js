'use strict';
// The page script is split by feature: public/js/app.js plus public/js/ui/*.js. Tests that cut it by text markers
// read it as one plain script again, without the import/export lines. anime.js goes last: one test runs it to the end.
const fs = require('node:fs'), path = require('node:path');
const dir = path.join(__dirname, '../public/js');
const parts = fs.readdirSync(path.join(dir, 'ui')).filter(file => !['core.js', 'anime.js'].includes(file)).sort();
module.exports = ['ui/core.js', 'app.js', ...parts.map(file => `ui/${file}`), 'ui/anime.js']
  .map(file => fs.readFileSync(path.join(dir, file), 'utf8')).join('\n').replace(/^(import|export) .*\n/gm, '');
