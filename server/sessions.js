'use strict';

const crypto = require('crypto');

function createSessions(secret) {
  const sign = value => crypto.createHmac('sha256', secret).update(value).digest('hex').slice(0, 32);
  const valid = value => {
    if (!/^[a-f0-9]{48}\.[a-f0-9]{32}$/.test(value || '')) return false;
    return crypto.timingSafeEqual(Buffer.from(value.slice(49)), Buffer.from(sign(value.slice(0, 48))));
  };
  return {
    read(req) {
      for (const item of String(req.headers.cookie || '').split(';')) {
        const match = /^\s*wp_st?=([^;]+)$/.exec(item);
        if (match && valid(match[1])) return match[1];
      }
      return null;
    },
    issue() { const id = crypto.randomBytes(24).toString('hex'); return `${id}.${sign(id)}`; },
  };
}

module.exports = { createSessions };
