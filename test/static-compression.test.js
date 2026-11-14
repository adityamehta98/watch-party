'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const zlib = require('node:zlib');
const assets = require('../server/assets');

test('page code is gzipped for browsers that accept it; images and other clients get the file as is', () => {
  const css = assets.get('css/app.css');
  const zipped = assets.encoded(css, 'gzip, deflate, br');
  assert.equal(zipped.headers['Content-Encoding'], 'gzip');
  assert.ok(zipped.body.length < css.body.length / 3);
  assert.deepEqual(zlib.gunzipSync(zipped.body), css.body);
  assert.deepEqual(assets.encoded(css, undefined), { body: css.body, headers: {} });
  const png = assets.get('icon-192.png');
  assert.equal(assets.encoded(png, 'gzip').body, png.body);
  assert.match(assets.etag(css), /^"[\w-]{20}"$/);
  assert.equal(assets.etag(assets.get('css/app.css')), assets.etag(css));
  assert.notEqual(assets.etag(png), assets.etag(css));
});
