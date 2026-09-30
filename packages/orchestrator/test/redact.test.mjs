// redactSecrets is the masking layer for every text Jevris shows or sends (evidence get, failing
// test names, retrieval excerpts, integration summaries). The contracts refuse credential shapes
// outright; this layer also masks the ordinary ones in command output (JEV-0026) and must leave
// prose about them alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_PATTERNS } from '@jevris/contracts';
import { redactSecrets } from '../dist/util.js';

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

test('credential assignments, Authorization headers and JWTs are masked, keeping their labels (JEV-0026)', () => {
  const masked = [
    ['password=hunter2hunter2-password-value', 'password=[redacted]'],
    ['DB_PASSWORD=s3cr3t-value-9', 'DB_PASSWORD=[redacted]'],
    ['PASSWORD: correcthorsebattery', 'PASSWORD: [redacted]'],
    ['passwd = "abcd1234efgh"', 'passwd = "[redacted]"'],
    ['{"client_secret": "abcd1234efgh"}', '{"client_secret": "[redacted]"}'],
    ['export MY_APP_SECRET_KEY=abcdefgh12345', 'export MY_APP_SECRET_KEY=[redacted]'],
    ['Authorization: Bearer abc123def456ghi', 'Authorization: Bearer [redacted]'],
    ['authorization: basic dXNlcjpwYXNzd29yZA==', 'authorization: basic [redacted]'],
    ['Proxy-Authorization: Bearer tokentokentoken', 'Proxy-Authorization: Bearer [redacted]'],
    [`curl -H "Authorization: Bearer ${JWT}"`, 'curl -H "Authorization: Bearer [redacted]"'],
    [`token was ${JWT} here`, 'token was [redacted] here'],
  ];
  for (const [input, expected] of masked) assert.equal(redactSecrets(input), expected, input);
});

test('prose about credentials, short values and bare labels are left alone (JEV-0026)', () => {
  const kept = [
    'the password field is required',
    'Bearer of bad news',
    'Bearer authentication is used for this endpoint',
    'secrets: none',
    'Enter your password:',
    'password=short',
    'reset password flow',
    'authorization header missing',
    'Authorization: Bearer',
    'Authorization: Bearer x',
    'ok 1 - rejects a bad password',
  ];
  for (const input of kept) assert.equal(redactSecrets(input), input, input);
});

test('masking is idempotent and its output is never refused by the contracts (JEV-0026)', () => {
  const text = `password=hunter2hunter2\nAuthorization: Bearer ${JWT}\nsk-ant-api03-abcdefghij1234567890\n`;
  const once = redactSecrets(text);
  assert.equal(redactSecrets(once), once);
  for (const pattern of SECRET_PATTERNS) assert.equal(new RegExp(pattern, 'u').test(once), false, pattern);
});
