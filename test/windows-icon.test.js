'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

// Read the final PE resource table independently of Windows' resource writer.
function resources(file) {
  const data = fs.readFileSync(file);
  const pe = data.readUInt32LE(0x3c), optional = pe + 24;
  assert.equal(data.toString('latin1', pe, pe + 4), 'PE\0\0');
  const sections = optional + data.readUInt16LE(pe + 20);
  const offset = rva => {
    for (let i = 0; i < data.readUInt16LE(pe + 6); i++) {
      const section = sections + i * 40, start = data.readUInt32LE(section + 12);
      if (rva >= start && rva < start + Math.max(data.readUInt32LE(section + 8), data.readUInt32LE(section + 16))) {
        return data.readUInt32LE(section + 20) + rva - start;
      }
    }
    throw new Error('Resource RVA outside PE sections');
  };
  const directories = optional + (data.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const base = offset(data.readUInt32LE(directories + 16));
  const result = new Map();
  function walk(relative, keys) {
    const directory = base + relative;
    const count = data.readUInt16LE(directory + 12) + data.readUInt16LE(directory + 14);
    for (let i = 0; i < count; i++) {
      const entry = directory + 16 + i * 8, name = data.readUInt32LE(entry), child = data.readUInt32LE(entry + 4);
      const nameAt = base + (name & 0x7fffffff);
      const key = name & 0x80000000 ? data.toString('utf16le', nameAt + 2, nameAt + 2 + data.readUInt16LE(nameAt) * 2) : name;
      const route = [...keys, key];
      if (child & 0x80000000) walk(child & 0x7fffffff, route);
      else {
        const record = base + child, start = offset(data.readUInt32LE(record));
        result.set(JSON.stringify(route), data.subarray(start, start + data.readUInt32LE(record + 4)));
      }
    }
  }
  walk(0, []);
  return result;
}

function verifyIcon(table) {
  const group = table.get('[14,1,0]');
  assert.ok(group, 'default icon group is present');
  assert.equal(group.readUInt16LE(2), 1);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(group.readUInt16LE(4), sizes.length);
  assert.equal([...table.keys()].filter(key => [3, 14].includes(JSON.parse(key)[0])).length, sizes.length + 1, 'old Node icon resources were removed');
  for (let i = 0; i < sizes.length; i++) {
    const entry = 6 + i * 14, size = sizes[i];
    assert.equal(group[entry] || 256, size);
    assert.equal(group[entry + 1] || 256, size);
    const png = table.get(JSON.stringify([3, group.readUInt16LE(entry + 12), 0]));
    assert.ok(png, 'group references an existing icon');
    assert.equal(png.length, group.readUInt32LE(entry + 8));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
}

test('Windows packaging replaces Node icons at every size and preserves other resources', { skip: process.platform !== 'win32' }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-party-icon-'));
  t.after(() => { assert.ok(temp.startsWith(path.join(os.tmpdir(), 'watch-party-icon-'))); fs.rmSync(temp, { recursive: true, force: true }); });
  const exe = path.join(temp, 'WatchParty.exe');
  fs.copyFileSync(process.execPath, exe);
  const original = resources(exe);
  const apply = () => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'build/set-windows-icon.ps1'), '-Executable', exe], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return resources(exe);
  };
  const updated = apply();
  verifyIcon(updated);
  for (const [key, value] of original) if (![3, 14].includes(JSON.parse(key)[0])) assert.deepEqual(updated.get(key), value, 'non-icon resource preserved: ' + key);
  assert.deepEqual(apply(), updated, 'repeated application does not accumulate resources');
  if (process.env.WATCHPARTY_BUILT_EXE) {
    const built = resources(process.env.WATCHPARTY_BUILT_EXE);
    verifyIcon(built);
    for (const [key, value] of updated) if ([3, 14].includes(JSON.parse(key)[0])) assert.deepEqual(built.get(key), value, 'SEA injection preserves the branded icon');
    assert.ok([...built.keys()].some(key => JSON.parse(key).includes('NODE_SEA_BLOB')), 'SEA payload remains embedded');
  }
});
