import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTROPY_BITS, FORMAT_RULES, MIN_KNOWN, REDACT_VERSION, RedactError, entropyBits, isEnvCommand, isHighEntropy, isKnownEnvValue, isSystemVariable,
  knownSpans, looksLikeEnvDump, makeRedactor, marker,
} from '../../src/store/redact.ts';

// Plan step 3, r4 §6.1 #1, invariant 14: three layers of redaction before source text reaches the
// snippet table. Every secret below is made up for the test.

const NO_ENV = makeRedactor({ env: {} });
const red = (text: string, command?: string) => NO_ENV.redact(command === undefined ? { text } : { text, command });

// A fixed 20-character value standing in for "random": the test must be repeatable.
const FOO_VALUE = 'q7Lw2ZxR9vKp4MnB8tYs';
// A made-up DeepSeek-shaped key, built at run time so secret scanners do not take this file for a leak.
const FAKE_SK = 'sk-' + '0123456789abcdef'.repeat(2);

test('format rules: each provider prefix, JWT, PEM, Authorization, bearer, URL credentials and key=value secrets is replaced; look-alikes are not', () => {
  const hits: [string, string, string][] = [
    ['sk-ant', 'key sk-ant-api03-Zx9_Qw8-Er7Ty6Ui5Op4 end', `key ${marker('sk-ant')} end`],
    ['sk', `DEEPSEEK_KEY ${FAKE_SK}!`, `DEEPSEEK_KEY ${marker('sk')}!`],
    ['github', 'remote ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 x', `remote ${marker('github')} x`],
    ['github', 'pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop', `pat ${marker('github')}`],
    ['aws', 'id AKIAIOSFODNN7EXAMPLE.', `id ${marker('aws')}.`],
    ['jwt', 'tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk ok', `tok ${marker('jwt')} ok`],
    ['pem', 'a\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\nz', `a\n${marker('pem')}\nz`],
    ['pem', 'cut -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA', `cut ${marker('pem')}`],
    ['authorization', 'Authorization: Bearer abc.def.ghi\nnext', `Authorization: ${marker('authorization')}\nnext`],
    ['authorization', 'proxy-authorization=Basic dXNlcjpwYXNz', `proxy-authorization=${marker('authorization')}`],
    ['bearer', "curl -H 'x: Bearer abcdefgh12345678' u", `curl -H 'x: Bearer ${marker('bearer')}' u`],
    ['url-credentials', 'db postgres://admin:hunter22@db.local:5432/app', `db postgres://${marker('url-credentials')}db.local:5432/app`],
    ['secret-param', 'login password=hunter2&next=1', `login password=${marker('secret-param')}&next=1`],
    ['secret-param', '{"apiKey": "abc123", "n": 1}', `{"apiKey": ${marker('secret-param')}, "n": 1}`],
    ['secret-param', 'access_token: xyz; ok', `access_token: ${marker('secret-param')}; ok`],
    ['secret-param', 'Cookie: sid=s3ss10n', `Cookie: ${marker('secret-param')}`],
    ['secret-param', "client_secret='shh'", `client_secret=${marker('secret-param')}`],
  ];
  for (const [rule, text, want] of hits) {
    const r = red(text);
    assert.equal(r.text, want, `${rule}: ${text}`);
    assert.ok((r.verdict.format[rule] ?? 0) >= 1, `${rule} counted: ${JSON.stringify(r.verdict)}`);
  }
  const misses = [
    'task-runner and sk-short and sk-ant',
    'ghp_short github_pat_x',
    'AKIA is a prefix',
    'eyJ alone, eyJabc.def',
    '-- BEGIN CERTIFICATE -- in prose',
    'the authorization flow, bearer bonds',
    'https://example.com/a:b and C:\\x@y',
    'max_tokens=4096 and passwords are hashed and token_count: 5',
  ];
  for (const text of misses) assert.deepEqual(red(text), { text, verdict: { ver: REDACT_VERSION, dropped: null, known: 0, format: {}, entropy: 0 } }, text);
  assert.deepEqual(FORMAT_RULES.map((r) => r.id), ['pem', 'sk-ant', 'sk', 'github', 'aws', 'jwt', 'authorization', 'bearer', 'url-credentials', 'secret-param']);
});

test('high entropy: a long token with letters and digits at 3.5 bits per character or more is replaced; words, paths and repetitive tokens are not', () => {
  const r = red(`blob ${FOO_VALUE}Xy and 0123456789abcdef0123456789abcdef01234567 done`);
  assert.equal(r.text, `blob ${marker('entropy')} and ${marker('entropy')} done`, 'a 40-hex digest is redacted too: fail closed');
  assert.equal(r.verdict.entropy, 2);
  for (const keep of ['ThisIsALongIdentifierWithoutDigitsAtAll', 'aaaaaaaaaaaaaaaaaaaaaaaa1', 'C:\\Users\\alexander\\projects\\shop-web\\src', 'v1.2.3-rc.4', 'short1A']) {
    assert.equal(red(keep).text, keep, keep);
  }
  assert.ok(isHighEntropy(FOO_VALUE));
  assert.equal(isHighEntropy('abcdefghijklmnopqrst'), false, 'no digit');
  assert.equal(isHighEntropy('a1a1a1a1a1a1a1a1a1a1a1'), false, 'one bit per character');
  assert.equal(isHighEntropy('a1B2c3D4e5F6g7H8'), false, 'too short at 16');
  assert.equal(entropyBits('aaaa'), 0);
  assert.equal(entropyBits('abcd'), 2);
  assert.ok(entropyBits(FOO_VALUE) >= ENTROPY_BITS);
});

test('known values: a custom variable FOO=<20 random characters> is replaced everywhere; a cwd under the user\'s profile stays as it is', () => {
  const env = {
    FOO: FOO_VALUE,
    USERPROFILE: 'C:\\Users\\alexander',
    USERNAME: 'alexander',
    HOMEPATH: '\\Users\\alexander',
    COMPUTERNAME: 'WORKSTATION-01',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    PROCESSOR_IDENTIFIER: 'Intel64 Family 6 Model 154 Stepping 3, GenuineIntel',
    MY_DIR: 'D:\\work\\secret-project',
    UNC_DIR: '\\\\fileserver\\share\\team',
    SHORT: 'abc1234',
    NODE_ENV: 'production',
  };
  const r = makeRedactor({ env });
  const text = [
    'cwd C:\\Users\\alexander\\proj on WORKSTATION-01 as alexander',
    `export FOO=${FOO_VALUE}; echo ${FOO_VALUE}`,
    'build D:\\work\\secret-project\\out at \\\\fileserver\\share\\team',
    'cpu Intel64 Family 6 Model 154 Stepping 3, GenuineIntel; abc1234; mode production',
  ].join('\n');
  const out = r.redact({ text });
  assert.equal(out.text, [
    'cwd C:\\Users\\alexander\\proj on WORKSTATION-01 as alexander',
    `export FOO=${marker('known')}; echo ${marker('known')}`,
    'build D:\\work\\secret-project\\out at \\\\fileserver\\share\\team',
    `cpu Intel64 Family 6 Model 154 Stepping 3, GenuineIntel; abc1234; mode ${marker('known')}`,
  ].join('\n'));
  assert.equal(out.verdict.known, 3, 'FOO twice, and NODE_ENV: an unknown variable is replaced, as r4 says');
  assert.equal(r.knownCount, 2);
  assert.ok(isSystemVariable('programfiles(x86)') && isSystemVariable('PROCESSOR_ARCHITECTURE') && isSystemVariable('Path') && !isSystemVariable('PATHX'));
  assert.equal(isKnownEnvValue('FOO', FOO_VALUE), true);
  assert.equal(isKnownEnvValue('FOO', 'x'.repeat(MIN_KNOWN - 1)), false);
  assert.equal(isKnownEnvValue('FOO', 'c:/lower/drive'), false);
  assert.equal(isKnownEnvValue('HOMEPATH', '\\Users\\alexander'), false, 'not path-like, exempt by name');
  assert.equal(isKnownEnvValue('MY_HOMEPATH', '\\Users\\alexander'), true, 'the same value under a name not on the list is replaced');
});

test('known values: pasted tokens are replaced; a short one is refused; the env is read once, own entries only', () => {
  const env: Record<string, string> = { API: 'k3y-for-the-test-0001' };
  const r = makeRedactor({ env, secrets: ['dsh-connect-token-abcdef'] });
  env.LATER = 'added-after-the-redactor';
  const out = r.redact({ text: 'u=dsh-connect-token-abcdef v=k3y-for-the-test-0001 w=added-after-the-redactor' });
  assert.equal(out.text, `u=${marker('known')} v=${marker('known')} w=added-after-the-redactor`);
  assert.throws(() => makeRedactor({ env: {}, secrets: ['short'] }), RedactError);
  assert.throws(() => makeRedactor({ env: {}, secrets: [42 as unknown as string] }), RedactError);
  assert.throws(() => makeRedactor({} as never), RedactError);
  const inherited = makeRedactor({ env: Object.create({ GHOST: 'inherited-value-123' }) as Record<string, string> });
  assert.equal(inherited.knownCount, 0, 'a value on the env\'s prototype is no entry of it');
  assert.throws(() => NO_ENV.redact({ text: 7 as unknown as string }), RedactError);
  assert.throws(() => NO_ENV.redact(Object.create({ text: 'x' }) as { text: string }), RedactError);
});

test('known values that overlap are replaced whole: no tail of the second survives', () => {
  const a = 'abcdefgh1234';
  const b = '1234WXYZ5678';
  const r = makeRedactor({ env: {}, secrets: [a, b] });
  const out = r.redact({ text: `x ${a}WXYZ5678 y ${b} z` });
  assert.equal(out.text, `x ${marker('known')} y ${marker('known')} z`);
  for (const frag of ['WXYZ', '5678', 'abcd']) assert.ok(!out.text.includes(frag), frag);
  assert.deepEqual(knownSpans([a, b], `${a}WXYZ5678`), [[0, 20]]);
  assert.deepEqual(knownSpans(['aaaaaaaa'], 'aaaaaaaaaa'), [[0, 10]], 'overlapping occurrences of one value merge too');
});

test('whole-block drop: the output of env, printenv, Get-ChildItem env: and .env reads is dropped whole, and so is text that looks like an env dump', () => {
  const dump = 'ALLUSERSPROFILE=C:\\ProgramData\nAPPDATA=C:\\Users\\a\\AppData\\Roaming\nMY_SECRET=not-in-our-env-1\n';
  for (const command of ['env', 'env | sort', 'printenv', 'printenv MY_SECRET', 'Get-ChildItem env:', 'gci Env:', 'ls env:', 'dir env:', 'Get-Item -Path env:MY_SECRET', 'cmd /c set', 'cat .env', 'type .env.local', 'Get-Content C:\\proj\\.env.production', "node -e \"[Environment]::GetEnvironmentVariables()\"", 'sh -c "export -p"']) {
    assert.ok(isEnvCommand(command), command);
    const r = red('MY_SECRET is here\nanything at all', command);
    assert.deepEqual(r, { text: marker('env-dump'), verdict: { ver: REDACT_VERSION, dropped: 'env-dump', known: 0, format: {}, entropy: 0 } }, command);
  }
  for (const command of ['env FOO=1 node x.js', 'set -e', 'git status', 'python -m venv .venv', 'source .env/bin/activate', 'echo environment']) assert.equal(isEnvCommand(command), false, command);
  assert.equal(red(dump).verdict.dropped, 'env-dump', 'no command known: the text itself looks like a dump');
  const psTable = 'Name                           Value\n----                           -----\nALLUSERSPROFILE                C:\\ProgramData\nMY_SECRET                      not-in-our-env-1\n';
  assert.ok(looksLikeEnvDump(psTable));
  assert.equal(red(psTable).text, marker('env-dump'));
  assert.equal(looksLikeEnvDump('one line a=b\nthen prose\nand more prose\nand the end'), false);
  assert.equal(looksLikeEnvDump('A=1\nB=2'), false, 'two lines are not a dump');
});

test('canary: a secret planted in source text appears 0 times in the output, wherever it sits, and never in the verdict', () => {
  const CANARY = 'cAnAry7Q2xK9mZp4WvR8';
  const OTHER = 'Zz9Yy8Xx7Ww6Vv5Uu4Tt';
  const viaSecret = makeRedactor({ env: {}, secrets: [CANARY, `${CANARY.slice(10)}${OTHER}`] });
  const viaEnv = makeRedactor({ env: { CUSTOM_VAR: CANARY } });
  const texts = [
    CANARY,
    `${CANARY}${CANARY}`,
    `start ${CANARY}`,
    `${CANARY} end`,
    `{"note":"${CANARY}","k":1}`,
    `https://h/x?q=${CANARY}&r=1`,
    `line1\r\n${CANARY}\r\nline3`,
    `pre${CANARY}${OTHER}post`,
    `\u202e${CANARY}\u202c`,
    `Authorization: ${CANARY}`,
    `ALPHA=${CANARY}\nBETA=2\nGAMMA=3`,
  ];
  for (const r of [viaSecret, viaEnv]) {
    for (const text of texts) {
      const out = r.redact({ text });
      assert.equal(out.text.split(CANARY).length - 1, 0, `canary leaked: ${JSON.stringify(out.text)}`);
      assert.ok(!JSON.stringify(out.verdict).includes(CANARY));
      assert.ok(!out.text.includes(CANARY.slice(0, 12)) && !out.text.includes(CANARY.slice(-12)), `a long fragment leaked: ${JSON.stringify(out.text)}`);
    }
  }
  // Not registered anywhere: the format rule and the entropy rule still keep it out.
  for (const text of [`sk-${CANARY}${CANARY}`, `token=${CANARY}`, `blob ${CANARY}`]) {
    const out = NO_ENV.redact({ text });
    assert.equal(out.text.split(CANARY).length - 1, 0, `${text} -> ${out.text}`);
  }
});

test('the result is a pure function of the redactor and the text: same input, same bytes and verdict; the verdict holds counts only, keys sorted', () => {
  const r = makeRedactor({ env: { FOO: FOO_VALUE }, secrets: ['pasted-token-000111'] });
  const text = `password=x token=y ${FOO_VALUE} sk-0123456789abcdef0123 AKIAIOSFODNN7EXAMPLE pasted-token-000111`;
  const first = r.redact({ text });
  for (let i = 0; i < 20; i++) assert.deepEqual(r.redact({ text }), first);
  assert.deepEqual(Object.keys(first.verdict), ['ver', 'dropped', 'known', 'format', 'entropy']);
  assert.deepEqual(Object.keys(first.verdict.format), [...Object.keys(first.verdict.format)].sort());
  assert.deepEqual(first.verdict, { ver: REDACT_VERSION, dropped: null, known: 2, format: { aws: 1, 'secret-param': 2, sk: 1 }, entropy: 0 });
});
