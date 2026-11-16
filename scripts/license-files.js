'use strict';

const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const ROOT = path.resolve(__dirname, '..');
const LICENSE_DIR = 'resources/licenses';
const PROJECT_LICENSE_FILES = [
  { from: 'LICENSE', to: `${LICENSE_DIR}/LICENSE-GIFA.txt` },
  { from: 'NOTICE', to: `${LICENSE_DIR}/NOTICE-GIFA.txt` },
  { from: 'LICENSES/MIT-legacy.txt', to: `${LICENSE_DIR}/LICENSE-MIT-LEGACY-GIFA.txt` }
];
const EXTRA_LICENSE_FILES = [
  ...PROJECT_LICENSE_FILES,
  { from: 'LICENSES/LGPL-3.0.txt', to: `${LICENSE_DIR}/LGPL-3.0.txt` },
  { from: 'LICENSES/libuiohook-NOTICE.txt', to: `${LICENSE_DIR}/libuiohook-NOTICE.txt` }
];
const ELECTRON_LICENSE_FILES = [
  { from: 'node_modules/electron/dist/LICENSE', to: `${LICENSE_DIR}/LICENSE.electron.txt` },
  { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: `${LICENSE_DIR}/LICENSES.chromium.html` }
];
const LICENSE_FILES = [...EXTRA_LICENSE_FILES, ...ELECTRON_LICENSE_FILES];

function verifyLicenseBundle(dir) {
  const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const { from, to } of LICENSE_FILES) {
    const expected = fs.readFileSync(path.join(ROOT, from));
    const actual = path.join(dir, to);
    if (!fs.existsSync(actual) || !fs.readFileSync(actual).equals(expected)) {
      throw new Error(`发行包许可缺失或过期：${actual}；请重新构建，不要复用旧产物`);
    }
  }

  const archive = path.join(dir, 'resources', 'app.asar');
  asar.uncache(archive);
  const packed = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (packed.license !== current.license || packed.version !== current.version) {
    throw new Error(`app.asar 的版本或许可与当前源码不一致：${archive}；请重新构建`);
  }
  return true;
}

module.exports = { LICENSE_DIR, PROJECT_LICENSE_FILES, EXTRA_LICENSE_FILES, ELECTRON_LICENSE_FILES, LICENSE_FILES, verifyLicenseBundle };
