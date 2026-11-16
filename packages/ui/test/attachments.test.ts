import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentName, withAttachments } from '../src/lib/attachments.ts';

describe('attachments', () => {
  it('names uploads with a timestamp and a safe file name', () => {
    const at = new Date('2026-11-16T13:58:50.123Z');
    assert.equal(attachmentName('Screenshot 2026-11-16 at 1.58.50 PM.png', at), '20261116-135850-Screenshot_2026-11-16_at_1.58.50_PM.png');
    assert.equal(attachmentName('../../etc/passwd', at), '20261116-135850-_.._etc_passwd');
    assert.equal(attachmentName('', at), '20261116-135850-file');
  });

  it('appends attached paths to the message', () => {
    assert.equal(withAttachments('look at this', []), 'look at this');
    assert.equal(withAttachments('look', ['/w/.axo/uploads/a.png']), 'look\n\nAttached file:\n- /w/.axo/uploads/a.png');
    assert.equal(withAttachments('', ['/a', '/b']), 'Attached files:\n- /a\n- /b');
  });
});
