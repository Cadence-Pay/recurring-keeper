#!/usr/bin/env node
/*
 * PolinRider scanner. Plain Node, no dependencies, reads files and never runs or prints them.
 *
 *   node scripts/polinrider-scan.mjs [directory] [--history] [--strict] [--json]
 *
 * PolinRider is a supply-chain campaign attributed to North Korea-linked actors. It appends an
 * obfuscated JavaScript payload to build config files (postcss, tailwind, eslint, next, vite,
 * webpack ...), hides it in fake font files, plants a propagation script (temp_auto_push.bat) that
 * rewrites the last commit and force-pushes, spreads through fake-interview repositories whose
 * .vscode/tasks.json runs a download-and-execute command when the folder is opened, and pulls
 * second-stage code from blockchain dead drops. The sources are listed in docs/SECURITY_SCANNING.md.
 *
 * What it checks:
 *   - payload signatures of both known obfuscator variants, and the infrastructure they talk to
 *   - the propagation script, its orchestrator and the .gitignore entry that hides it
 *   - .vscode/tasks.json that runs commands on folder open
 *   - fake font files that are not fonts
 *   - package.json and lockfiles that use the known malicious npm packages, or install hooks that
 *     download or execute code
 *   - variant-independent signs in config files: code after a long run of spaces, very long lines,
 *     eval, writes to global
 *   - with --history, the same signatures in every commit, because the campaign rewrites history
 *
 * Exit codes: 0 nothing high found, 1 a high finding (or any finding with --strict), 2 bad usage.
 * It cannot prove a repository is clean. Signatures go stale when the actor rotates them, which has
 * already happened once. Treat a clean result as "no known indicator", not as "safe".
 *
 * The indicator strings below are built from fragments on purpose, so that this file does not match
 * its own signatures.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const j = (...parts) => parts.join('');

/** Indicators from the OpenSourceMalware PolinRider dossier (read 2026-11-08). */
export const SIGNATURES = {
  v1Marker: j('rmcej', '%otb%'),
  v2Marker: j('Cot%3t', '=shtP'),
  v1Seed1: j('2857', '687'),
  v1Seed2: j('2667', '686'),
  v1Decoder: j('_$_', '1e42'),
  v2Seed1: j('1111', '436'),
  v2Seed2: j('3896', '884'),
  globalBang: j("global['", "!']"),
  globalV: j("global['", "_V']"),
  globalR: j("global['r']", ' = require'),
  globalM: j("global['m']", ' = module'),
  tronAddresses: [
    j('TMfKQEd7TJJa5xNZ', 'JZ2Lep838vrzrs7mAP'),
    j('TXfxHUet9pJVU1Bg', 'VkBAbrES4YUc1nGzcG'),
  ],
  aptosHashes: [
    j('0xbe037400670fbf1c32364f762975908d', 'c43eeb38759263e7dfcdabc76380811e'),
    j('0x3f0e5781d0855fb460661ac63257376d', 'b1941b2bb522499e4757ecb3ebd5dce3'),
  ],
  xorKeys: [j('2[gWfGj;', '<:-93Z^C'), j('m6:tTh^', 'D)cBz?NM]')],
  templateUuid: j('e9b53a7c-2342-4b15', '-b02d-bd8b8f6a03f9'),
  vercelHosts: [
    j('260120', '.vercel.app'),
    j('default-configuration', '.vercel.app'),
    j('vscode-settings-bootstrap', '.vercel.app'),
    j('vscode-settings-config', '.vercel.app'),
    j('vscode-bootstrapper', '.vercel.app'),
    j('vscode-load-config', '.vercel.app'),
  ],
  chainEndpoints: [
    j('api.tron', 'grid.io'),
    j('fullnode.mainnet.', 'aptoslabs.com'),
    j('bsc-data', 'seed.binance.org'),
    j('bsc-rpc.', 'publicnode.com'),
  ],
};

/** npm packages published by the actor, impersonating Tailwind and PostCSS helpers. */
export const MALICIOUS_PACKAGES = [
  'tailwindcss-style-animate',
  'tailwind-mainanimation',
  'tailwind-autoanimation',
  'tailwind-animationbased',
  'tailwindcss-typography-style',
  'tailwindcss-style-modify',
  'tailwindcss-animate-style',
];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', '.next', 'coverage', 'out']);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const JS_FAMILY = /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i;
const CONFIGISH =
  /^(?:(?:postcss|tailwind|eslint|next|astro|vite|vitest|webpack|vue|gridsome|babel|jest|rollup|nuxt|svelte|tsup|prettier)\.config|truffle|App|index)\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i;
const LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
]);

/** @typedef {{severity: 'high' | 'warn', rule: string, file: string, line: number | null, message: string}} Finding */

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Find the first of several strings in a text. Returns the index, or -1. */
function firstIndex(text, needles) {
  for (const needle of needles) {
    const at = text.indexOf(needle);
    if (at !== -1) return at;
  }
  return -1;
}

/**
 * Check the text of one file against the content rules.
 *
 * @param {string} file - Path relative to the scanned directory, with forward slashes.
 * @param {string} text - The file's text.
 * @returns {Finding[]}
 */
export function scanText(file, text) {
  /** @type {Finding[]} */
  const findings = [];
  const add = (severity, rule, index, message) =>
    findings.push({ severity, rule, file, line: index < 0 ? null : lineOf(text, index), message });
  const s = SIGNATURES;
  const has = (needle) => text.indexOf(needle) !== -1;

  for (const [name, marker] of [
    ['payload-marker-v1', s.v1Marker],
    ['payload-marker-v2', s.v2Marker],
  ]) {
    const at = text.indexOf(marker);
    if (at !== -1) add('high', name, at, 'obfuscated payload marker of a known PolinRider variant');
  }
  const injected = new RegExp(j("global\\[\\s*'", "(?:!|_V)'\\s*\\]\\s*=\\s*'8-"));
  const injectedAt = text.search(injected);
  if (injectedAt !== -1) {
    add(
      'high',
      'payload-injection-tag',
      injectedAt,
      'per-victim injection tag assigned to a global',
    );
  }
  if (has(s.globalBang) && (has(s.v1Seed1) || has(s.v1Decoder))) {
    add(
      'high',
      'payload-v1-combination',
      text.indexOf(s.globalBang),
      'global marker with a known seed or decoder name',
    );
  }
  if (has(s.globalV) && has(s.v2Seed1)) {
    add(
      'high',
      'payload-v2-combination',
      text.indexOf(s.globalV),
      'global marker with a known seed',
    );
  }
  if (has(s.globalR) && has(s.globalM) && (has(s.v1Seed1) || has(s.v2Seed1))) {
    add(
      'high',
      'payload-require-module',
      text.indexOf(s.globalR),
      'require and module exposed to globals next to a known seed',
    );
  }

  for (const [rule, list, message] of [
    ['c2-tron-address', s.tronAddresses, 'TRON dead-drop address used by the second stage'],
    ['c2-aptos-hash', s.aptosHashes, 'Aptos transaction used by the second stage'],
    ['c2-xor-key', s.xorKeys, 'XOR key used to decrypt the second stage'],
    ['c2-template-uuid', [s.templateUuid], 'identifier of the malicious fake-interview template'],
    ['c2-vercel-host', s.vercelHosts, 'bootstrap host used by the folder-open command'],
  ]) {
    const at = firstIndex(text, list);
    if (at !== -1) add('high', rule, at, message);
  }
  const bootstrap = /https?:\/\/[a-z0-9-]+\.vercel\.app\/settings\/(?:mac|linux|win)\b/i.exec(text);
  if (bootstrap !== null) {
    add(
      'high',
      'c2-vercel-settings-url',
      bootstrap.index,
      'download URL shaped like the campaign bootstrap endpoint',
    );
  }

  if (JS_FAMILY.test(file)) {
    const at = firstIndex(text, s.chainEndpoints);
    if (at !== -1)
      add(
        'warn',
        'chain-endpoint-in-js',
        at,
        'a blockchain API endpoint in source code, the way the second stage reaches its dead drop',
      );
  }

  const name = basename(file);
  if (CONFIGISH.test(name)) {
    const pad = /[ \t]{100,}\S/.exec(text);
    const hasEval = /\beval\s*\(/.test(text);
    const hasGlobal = /\bglobal\s*\[/.test(text);
    if (pad !== null && (hasEval || hasGlobal)) {
      add(
        'high',
        'padded-code-with-eval',
        pad.index,
        'code after a long run of spaces together with eval or a write to global',
      );
    } else if (pad !== null) {
      add(
        'warn',
        'padded-code',
        pad.index,
        'code after a long run of spaces on one line, where hidden payloads are appended',
      );
    }
    if (hasEval && pad === null)
      add('warn', 'eval-in-config', text.search(/\beval\s*\(/), 'eval in a build config file');
    if (hasGlobal && pad === null)
      add(
        'warn',
        'global-in-config',
        text.search(/\bglobal\s*\[/),
        'write to a global in a build config file',
      );
    const lines = text.split('\n');
    let offset = 0;
    for (const line of lines) {
      if (line.length > 1500) {
        add(
          'warn',
          'very-long-line',
          offset,
          `a line of ${String(line.length)} characters in a build config file`,
        );
        break;
      }
      offset += line.length + 1;
    }
  }

  if (/\.bat$/i.test(file) && /LAST_COMMIT_DATE/.test(text) && /LAST_COMMIT_TIME/.test(text)) {
    add(
      'high',
      'propagation-script-content',
      text.indexOf('LAST_COMMIT_DATE'),
      'batch file that reads the last commit date and time, as the propagation script does',
    );
  }

  if (/(?:^|\/)\.vscode\/tasks\.json$/i.test(file)) {
    const onOpen = text.search(/"runOn"\s*:\s*"folderOpen"/);
    if (onOpen !== -1) {
      const downloads =
        /\b(?:curl|wget|bash|sh\s+-c|powershell|iex|Invoke-Expression|Invoke-WebRequest|cmd\s*\/c|node\s+-e)\b/i.test(
          text,
        );
      add(
        downloads ? 'high' : 'warn',
        downloads ? 'tasks-folder-open-download' : 'tasks-folder-open',
        onOpen,
        downloads
          ? 'a VS Code task that runs a download or shell command as soon as the folder is opened'
          : 'a VS Code task that runs as soon as the folder is opened',
      );
    }
  }

  if (name === '.gitignore' || /(?:^|\/)\.gitignore$/.test(file)) {
    const at = text.search(/^\s*config\.bat\s*$/m);
    if (at !== -1)
      add(
        'high',
        'gitignore-hides-orchestrator',
        at,
        'config.bat is hidden through .gitignore, as the campaign does',
      );
  }

  return findings;
}

/**
 * Check a package.json: known malicious dependencies and install hooks that download or run code.
 *
 * @param {string} file - Relative path.
 * @param {string} text - File text.
 * @returns {Finding[]}
 */
export function checkPackageJson(file, text) {
  /** @type {Finding[]} */
  const findings = [];
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [
      {
        severity: 'warn',
        rule: 'package-json-unreadable',
        file,
        line: null,
        message: 'package.json is not valid JSON',
      },
    ];
  }
  if (typeof pkg !== 'object' || pkg === null) return findings;
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const deps = pkg[section];
    if (typeof deps !== 'object' || deps === null) continue;
    for (const dep of Object.keys(deps)) {
      if (MALICIOUS_PACKAGES.includes(dep)) {
        findings.push({
          severity: 'high',
          rule: 'malicious-dependency',
          file,
          line: null,
          message: `${section} lists ${dep}, a package published by the PolinRider actor`,
        });
      }
    }
  }
  const scripts = pkg.scripts;
  if (typeof scripts === 'object' && scripts !== null) {
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
      const command = scripts[hook];
      if (typeof command !== 'string') continue;
      if (/\b(?:curl|wget|eval|powershell|base64|node\s+-e)\b|\.bat\b|https?:\/\//i.test(command)) {
        findings.push({
          severity: 'high',
          rule: 'install-hook-runs-code',
          file,
          line: null,
          message: `the ${hook} script downloads or runs code`,
        });
      }
    }
  }
  return findings;
}

/**
 * Check a lockfile for the malicious package names.
 *
 * @param {string} file - Relative path.
 * @param {string} text - File text.
 * @returns {Finding[]}
 */
export function checkLockfile(file, text) {
  /** @type {Finding[]} */
  const findings = [];
  for (const name of MALICIOUS_PACKAGES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Not part of a longer name, and not the tail of a scoped package such as @scope/name.
    const re = new RegExp(`(?<![A-Za-z0-9._-]|@[A-Za-z0-9._-]+/)${escaped}(?![A-Za-z0-9._-])`);
    const m = re.exec(text);
    if (m !== null) {
      findings.push({
        severity: 'high',
        rule: 'malicious-dependency-locked',
        file,
        line: lineOf(text, m.index),
        message: `the lockfile contains ${name}, a package published by the PolinRider actor`,
      });
    }
  }
  return findings;
}

/**
 * A .woff or .woff2 file must start with the font signature. The campaign hides payloads in files
 * that carry a font name but are not fonts.
 *
 * @param {string} file - Relative path.
 * @param {Buffer} head - The first bytes of the file.
 * @returns {Finding[]}
 */
export function checkFontHeader(file, head) {
  const magic = head.subarray(0, 4).toString('latin1');
  if (magic === 'wOF2' || magic === 'wOFF') return [];
  const readable = head.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127));
  return [
    {
      severity: 'high',
      rule: 'fake-font',
      file,
      line: null,
      message: readable
        ? 'a font file that is plain text, which is how the campaign hides a payload'
        : 'a font file that does not start with the font signature',
    },
  ];
}

function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return !sample.includes(0);
}

function* walk(root, dir = root) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(root, full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function readHead(path, bytes) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan the files of a directory tree. Skips `.git`, `node_modules`, build output and symbolic links.
 *
 * @param {string} root - Directory to scan.
 * @returns {{findings: Finding[], files: number}}
 */
export function scanTree(root) {
  /** @type {Finding[]} */
  const findings = [];
  let files = 0;
  for (const full of walk(root)) {
    files++;
    const rel = relative(root, full).split(sep).join('/');
    const name = basename(rel);
    if (name === 'temp_auto_push.bat') {
      findings.push({
        severity: 'high',
        rule: 'propagation-script',
        file: rel,
        line: null,
        message:
          'the propagation script left behind by the campaign, direct evidence of a past compromise',
      });
    }
    if (name === 'config.bat') {
      findings.push({
        severity: rel === 'config.bat' ? 'high' : 'warn',
        rule: 'orchestrator-script',
        file: rel,
        line: null,
        message: 'config.bat, the hidden orchestrator the propagation script calls',
      });
    }
    if (/\.woff2?$/i.test(name)) {
      const head = readHead(full, 64);
      findings.push(...checkFontHeader(rel, head));
      continue;
    }
    let size;
    try {
      size = lstatSync(full).size;
    } catch {
      continue;
    }
    if (size > MAX_TEXT_BYTES) continue;
    const buffer = readFileSync(full);
    if (!isProbablyText(buffer)) continue;
    const text = buffer.toString('utf8');
    findings.push(...scanText(rel, text));
    if (name === 'package.json') findings.push(...checkPackageJson(rel, text));
    if (LOCKFILES.has(name)) findings.push(...checkLockfile(rel, text));
  }
  return { findings, files };
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status === null) return undefined;
  return { status: r.status, stdout: r.stdout ?? '' };
}

/**
 * Search every commit of the repository for the fixed-string indicators. The campaign rewrites
 * history, and the payload can sit in an older commit while the latest files look clean.
 *
 * @param {string} root - A directory inside a git repository.
 * @returns {{findings: Finding[], commits: number, skipped: string | null}}
 */
export function scanHistory(root) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside === undefined || inside.status !== 0) {
    return { findings: [], commits: 0, skipped: 'not a git repository, or git is not installed' };
  }
  const list = git(root, ['rev-list', '--all']);
  const commits = list === undefined ? [] : list.stdout.split('\n').filter((line) => line !== '');
  const s = SIGNATURES;
  const needles = [
    s.v1Marker,
    s.v2Marker,
    j("global['", "!']='8-"),
    j("global['", "_V']='8-"),
    ...s.tronAddresses,
    ...s.aptosHashes,
    ...s.xorKeys,
    s.templateUuid,
    ...s.vercelHosts,
  ];
  /** @type {Finding[]} */
  const findings = [];
  const seen = new Set();
  const chunk = 100;
  for (let i = 0; i < commits.length; i += chunk) {
    const revs = commits.slice(i, i + chunk);
    const r = git(root, ['grep', '-I', '-l', '-F', ...needles.flatMap((n) => ['-e', n]), ...revs]);
    if (r === undefined || r.status > 1) continue;
    for (const line of r.stdout.split('\n')) {
      const m = /^([0-9a-f]{40}):(.+)$/.exec(line);
      if (m === null) continue;
      const key = `${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        severity: 'high',
        rule: 'history-signature',
        file: m[2],
        line: null,
        message: `an indicator appears in the history of this file (first seen in commit ${m[1].slice(0, 10)})`,
      });
    }
  }
  const names = git(root, ['log', '--all', '--name-only', '--format=']);
  if (names !== undefined) {
    const artifacts = new Set(
      names.stdout.split('\n').filter((p) => /(?:^|\/)(?:temp_auto_push|config)\.bat$/.test(p)),
    );
    for (const path of artifacts) {
      findings.push({
        severity: 'high',
        rule: 'history-propagation-script',
        file: path,
        line: null,
        message: 'the propagation script or its orchestrator exists somewhere in the history',
      });
    }
  }
  return { findings, commits: commits.length, skipped: null };
}

/** Read the command line. Throws an Error with a readable message on bad input. */
export function parseArgs(argv) {
  const options = { dir: '.', history: false, strict: false, json: false };
  let dirSeen = false;
  for (const arg of argv) {
    if (arg === '--history') options.history = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else if (dirSeen) throw new Error('Give at most one directory.');
    else {
      options.dir = arg;
      dirSeen = true;
    }
  }
  return options;
}

/**
 * Run the scanner.
 *
 * @param {string[]} argv - Command line arguments.
 * @param {(line: string) => void} out - Where output goes.
 * @returns {number} The exit code.
 */
export function run(argv, out) {
  let options;
  try {
    options = parseArgs(argv);
    lstatSync(options.dir);
  } catch (error) {
    out(`usage error: ${error instanceof Error ? error.message : 'bad arguments'}`);
    return 2;
  }
  const tree = scanTree(options.dir);
  const history = options.history
    ? scanHistory(options.dir)
    : { findings: [], commits: 0, skipped: null };
  const findings = [...tree.findings, ...history.findings];
  const high = findings.filter((f) => f.severity === 'high');
  const warn = findings.filter((f) => f.severity === 'warn');
  if (options.json) {
    out(JSON.stringify({ files: tree.files, commits: history.commits, findings }, null, 2));
  } else {
    for (const f of findings) {
      out(
        `${f.severity === 'high' ? 'HIGH' : 'warn'}  ${f.file}${f.line === null ? '' : `:${String(f.line)}`}  [${f.rule}] ${f.message}`,
      );
    }
    out(
      `Scanned ${String(tree.files)} files${options.history ? ` and ${String(history.commits)} commits` : ''}: ${String(high.length)} high, ${String(warn.length)} warnings.`,
    );
    if (history.skipped !== null) out(`History was not scanned: ${history.skipped}.`);
    out('No finding means no known indicator, not proof of safety. See docs/SECURITY_SCANNING.md.');
  }
  return high.length > 0 || (options.strict && warn.length > 0) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2), (line) => {
    process.stdout.write(`${line}\n`);
  });
}
