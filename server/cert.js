'use strict';
// Makes a self-signed HTTPS certificate with nothing but Node's built-in crypto.
// Browsers only allow camera/mic on https pages; this gives guests an https link without any
// certificate company (they click past a one-time "not private" warning).
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const octet = b => tlv(0x04, b);
const utf8 = s => tlv(0x0c, Buffer.from(s, 'utf8'));
const ctx = (n, body, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, body);
function int(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function oid(str) {
  const parts = str.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = p >> 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>= 7; }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
function utcTime(d) {
  const p = n => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}
const bitString = b => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));

function makeCert({ ips = [], names = [], days = 397 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const sigAlg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = seq(set(seq(oid('2.5.4.3'), utf8('Watch Party'))), set(seq(oid('2.5.4.10'), utf8('Watch Party (home PC)'))));
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const notBefore = new Date(Date.now() - 24 * 3600e3);
  const notAfter = new Date(Date.now() + days * 24 * 3600e3);
  const san = [];
  for (const n of ['localhost', ...names]) san.push(ctx(2, Buffer.from(n, 'ascii'), false));
  for (const ip of ['127.0.0.1', ...ips]) if (net.isIPv4(ip)) san.push(ctx(7, Buffer.from(ip.split('.').map(Number)), false));
  const extensions = seq(
    seq(oid('2.5.29.17'), octet(seq(...san))),                          // subjectAltName
    seq(oid('2.5.29.19'), octet(seq())),                                 // basicConstraints: not a CA
    seq(oid('2.5.29.37'), octet(seq(oid('1.3.6.1.5.5.7.3.1')))),        // extKeyUsage: serverAuth
  );
  const tbs = seq(
    ctx(0, int(Buffer.from([2]))),       // version v3
    int(serial), sigAlg, name,
    seq(utcTime(notBefore), utcTime(notAfter)),
    name, spki,
    ctx(3, extensions),
  );
  const signature = crypto.sign('sha256', tbs, privateKey); // DER-encoded ECDSA signature
  const der = seq(tbs, sigAlg, bitString(signature));
  const pem = b => b.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${pem(der)}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    ips, notAfter: notAfter.getTime(),
  };
}

// Reuse the saved certificate so guests only see the warning once; make a new one if the IP changed.
function loadOrCreate(file, ips) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const covers = ips.every(ip => saved.ips.includes(ip));
    if (covers && saved.notAfter - Date.now() > 7 * 24 * 3600e3) return saved;
  } catch { /* none yet */ }
  const c = makeCert({ ips });
  try { fs.writeFileSync(file, JSON.stringify(c)); } catch { /* read-only folder */ }
  return c;
}

module.exports = { makeCert, loadOrCreate };
