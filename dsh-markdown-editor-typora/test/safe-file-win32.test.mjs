import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const safeFile = require(join(here, '..', '..', 'MarkPilot-CM6', 'shell', 'safe-file.js'));

test('P4 safe-file maps Windows failure codes without matching localized text', () => {
  assert.equal(safeFile.stableWin32Code({ win32: 5 }), 'EACCES');
  assert.equal(safeFile.stableWin32Code({ win32: 19 }), 'EROFS');
  assert.equal(safeFile.stableWin32Code({ win32: 32 }), 'EBUSY');
  assert.equal(safeFile.stableWin32Code({ win32: 33 }), 'EBUSY');
  assert.equal(safeFile.stableWin32Code({ win32: 112 }), '');
  assert.equal(safeFile.stableWin32Code({}), '');
});
