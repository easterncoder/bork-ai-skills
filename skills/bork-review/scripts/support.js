'use strict';

/* Shared data, filesystem and subprocess mechanics for the CLI helpers. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const os = require('node:os');

/** Reject unsupported runtimes before reading or mutating workflow records. */
function requireNode() {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('dependency_blocker: Node.js 22 or newer is required.');
  }
}
requireNode();
/** Test PHP-compatible condition values, including empty collections. */
function truth(value) {
  if (value instanceof Number) value = value.valueOf();
  return !(value == null || value === false || value === 0 || value === '' || value === '0' || typeof value === 'object' && Object.keys(value).length === 0);
}

/** Read nested records without following a missing intermediate key. */
function get(value, ...keys) {
  for (const key of keys) {
    if (value == null || !Object.hasOwn(Object(value), key)) return undefined;
    value = value[key];
  }
  return value;
}

/** Clone JSON-like values while retaining callable dependencies. */
function clone(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (const k of Object.keys(value)) out[k] = clone(value[k]);
    return out;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const k of Object.keys(value)) Object.defineProperty(out, k, {
      value: clone(value[k]),
      writable: true,
      enumerable: true,
      configurable: true
    });
    return out;
  }
  return value;
}
/** Preserve type-sensitive structural comparisons for durable records. */
function equal(a, b) {
  if (a instanceof Number || b instanceof Number) return a instanceof Number && b instanceof Number && a.valueOf() === b.valueOf();
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ak = Object.keys(a),
    bk = Object.keys(b);
  return ak.length === bk.length && ak.every((key, index) => key === bk[index] && equal(a[key], b[key]));
}

/** Add numbers or combine keyed records without overwriting existing keys. */
function add(a, b) {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const result = clone(a);
    for (const k of Object.keys(b)) if (!Object.hasOwn(result, k)) result[k] = clone(b[k]);
    return result;
  }
  return a + b;
}
/** Assign a nested key, creating only missing record containers. */
function set(root, keys, operation, value) {
  let target = root;
  for (const k of keys.slice(0, -1)) {
    if (target[k] == null) target[k] = [];
    target = target[k];
  }
  const k = keys.at(-1);
  if (operation === 'DELETE') {
    delete target[k];
    return;
  }
  let result = value;
  if (operation === '+=') result = add(target[k], value);
  if (operation === '-=') result = target[k] - value;
  if (operation === '.=') result = string(target[k]) + string(value);
  if (operation === '??=') result = target[k] ?? value;
  Object.defineProperty(target, k, {
    value: clone(result),
    writable: true,
    enumerable: true,
    configurable: true
  });
  return result;
}
/** Append a positional entry while preserving keyed collection entries. */
function append(root, keys, value) {
  let target = root;
  for (const k of keys) {
    if (target[k] == null) target[k] = [];
    target = target[k];
  }
  const indices = Object.keys(target).filter(k => /^(0|[1-9]\d*)$/.test(k)).map(Number);
  target[indices.length ? Math.max(...indices) + 1 : 0] = clone(value);
  return value;
}
/** Enumerate keyed data without exposing inherited object properties. */
function entries(value) {
  return Object.entries(value ?? {}).map(([k, v]) => [/^(0|[1-9]\d*)$/.test(k) ? Number(k) : k, v]);
}
/** Construct a keyed collection with numeric and string keys. */
function entriesArray(pairs) {
  const out = [];
  for (const [k, v] of pairs) Object.defineProperty(out, k, {
    value: v,
    writable: true,
    enumerable: true,
    configurable: true
  });
  return out;
}
/** Convert a keyed collection to a JSON object explicitly. */
function object(value) {
  return Object.fromEntries(entries(value));
}
/** Normalize a collection to its positional values. */
function array(value) {
  return value == null ? [] : typeof value === 'object' ? value : [value];
}
/** Convert supported scalar values without JavaScript's undefined spelling. */
function string(value) {
  return value == null || value === false ? '' : value === true ? '1' : String(value);
}
/** Convert numeric fields with the source command's integer semantics. */
function integer(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
/** Convert collections to JSON with keyed-array and empty-map distinctions. */
function jsonValue(value) {
  if (value instanceof Number) return value.valueOf();
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value) && Object.keys(value).every((k, i) => k === String(i))) return value.map(jsonValue);
  const out = {};
  for (const k of Object.keys(value)) Object.defineProperty(out, k, {
    value: jsonValue(value[k]),
    enumerable: true
  });
  return out;
}
/** Serialize records without logs or lossy unsupported values. */
function json_encode(value, flags = 0) {
  let encoded = JSON.stringify(jsonValue(value), null, flags & 2 ? 4 : undefined);
  encoded = encoded.replace(/[\u007f-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  return flags & 64 ? encoded : encoded.replaceAll('/', '\\/');
}
/** Decode JSON while preserving lists and keyed objects. */
function json_decode(value) {
  return JSON.parse(value, (key, item, context) => {
    if (typeof item !== 'number') return item;
    if (!Number.isFinite(item)) throw new Error('JSON number must be finite.');
    if (context?.source && /[.eE]/.test(context.source)) return new Number(item);
    if (!Number.isSafeInteger(item)) throw new Error('JSON integer exceeds the exact supported range.');
    return item;
  });
}
/** Raise an expression-level failure. */
function fail(error) {
  throw error;
}
/** Sleep synchronously for bounded local polling. */
function usleep(microseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, microseconds / 1000);
}
/** Check filesystem attributes without surfacing missing-file exceptions. */
function statCheck(filename, method) {
  try {
    return fs.lstatSync(filename)[method]();
  } catch {
    return false;
  }
}
/** Read regular content, including procfs pseudo-files, without warning output. */
function file_get_contents(filename) {
  try {
    return fs.readFileSync(filename === '/dev/stdin' ? 0 : filename, 'utf8');
  } catch {
    return false;
  }
}
/** Resolve existing paths without guessing absent identities. */
function realpath(filename) {
  try {
    return fs.realpathSync(filename);
  } catch {
    return false;
  }
}
/** Test access against the operating system's effective permissions. */
function access(filename, mode) {
  try {
    fs.accessSync(filename, mode);
    return true;
  } catch {
    return false;
  }
}
/** Allocate a temporary file exclusively inside the required directory. */
function tempnam(directory, prefix) {
  try {
    for (let i = 0; i < 10; i++) {
      const filename = path.join(directory, prefix + crypto.randomBytes(12).toString('hex'));
      try {
        fs.closeSync(fs.openSync(filename, 'wx', 0o600));
        return filename;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
  } catch {}
  return false;
}
/** Atomically replace a file after a complete write and close. */
function atomicWrite(filename, content, prefix = '.bork-') {
  if (statCheck(filename, 'isSymbolicLink') || !statCheck(path.dirname(filename), 'isDirectory')) throw new Error('Unsafe target or missing destination directory.');
  let temporary, descriptor;
  for (let attempt = 0; attempt < 10; attempt++) {
    temporary = path.join(path.dirname(filename), prefix + crypto.randomBytes(12).toString('hex'));
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  if (descriptor === undefined) throw new Error('Unable to create temporary file.');
  try {
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Run argument arrays with bounded memory and optional timeout. */
function processResult(args, {
  cwd,
  env,
  timeout,
  stdio = 'pipe',
  input
} = {}) {
  const result = cp.spawnSync(args[0], args.slice(1), {
    cwd,
    env,
    timeout,
    stdio,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    killSignal: 'SIGKILL'
  });
  return {
    code: result.status ?? (result.signal ? 128 + (os.constants.signals[result.signal] ?? 0) : 1),
    output: result.stdout ?? '',
    signal: result.signal ?? null,
    error: result.error ?? null
  };
}
/** Preserve numeric token types across the private lock subprocess boundary. */
function transportJson(value) {
  if (value instanceof Number) {
    const numeric = value.valueOf();
    return Number.isInteger(numeric) ? String(numeric) + '.0' : String(numeric);
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value) && Object.keys(value).every((key, index) => key === String(index))) return '[' + value.map(transportJson).join(',') + ']';
  return '{' + Object.keys(value).map(key => JSON.stringify(key) + ':' + transportJson(value[key])).join(',') + '}';
}
/** Run a helper under the same advisory lock used by legacy PHP helpers. */
function lockedCommand(lockfile, script, args, input) {
  if (statCheck(lockfile, 'isSymbolicLink') || !statCheck(path.dirname(lockfile), 'isDirectory')) throw new Error('Unsafe batch lock path.');
  const result = processResult(['flock', '--exclusive', '--', lockfile, process.execPath, script, ...args], {
    input: transportJson(input)
  });
  if (result.error) throw new Error('dependency_blocker: util-linux flock is required for interoperable record locking.');
  if (result.code !== 0) {
    try {
      const reply = JSON.parse(result.output);
      throw new Error(reply.error);
    } catch (e) {
      throw new Error(e.message || 'Locked helper failed.');
    }
  }
  return JSON.parse(result.output).result;
}
/** Parse a PCRE-style delimiter and retain supported regular expression flags. */
function regex(pattern, global = false) {
  const end = pattern.lastIndexOf(pattern[0]);
  let body = pattern.slice(1, end),
    flags = pattern.slice(end + 1).replace(/[^imsu]/g, '');
  body = body.replace(/\\A/g, '^').replace(/\\z/g, '$').replace(/\\R/g, '(?:\\r\\n|[\\n\\v\\f\\r\\u0085\\u2028\\u2029])');
  return new RegExp(body, flags + (global ? 'g' : ''));
}
/** Match a source regular expression and publish its capture list. */
function preg_match(pattern, text, publish) {
  const match = regex(pattern).exec(string(text));
  if (publish) publish(match ? Array.from(match) : []);
  return match ? 1 : 0;
}
/** Collect regular expression matches with source-compatible grouped captures. */
function preg_match_all(pattern, text, publish, flags = 0) {
  const all = Array.from(string(text).matchAll(regex(pattern, true)), m => Array.from(m));
  if (publish) publish(flags === 2 ? all : all[0]?.map((_, i) => all.map(m => m[i])) ?? []);
  return all.length;
}
/** Resolve callable names used by shared collection operations. */
function callable(fn) {
  if (typeof fn === 'function') return fn;
  if (fn === 'canonical') return require('./evidence.js').canonical;
  if (fn === 'environmentCommand') return require('../../bork-doitall/scripts/environment.js').environmentCommand;
  return exports[fn];
}
/** Map values while retaining keyed collection identity. */
function array_map(fn, value) {
  const out = Array.isArray(value) ? [] : {};
  for (const [k, v] of entries(value)) out[k] = callable(fn)(v);
  return out;
}
/** Filter values without reindexing their source keys. */
function array_filter(value, fn = truth) {
  const out = Array.isArray(value) ? [] : {};
  for (const [k, v] of entries(value)) if (callable(fn)(v)) out[k] = clone(v);
  return out;
}
/** Merge list entries by position and keyed entries by their original key. */
function array_merge(...values) {
  const out = [];
  for (const value of values) for (const [k, v] of entries(value)) {
    if (typeof k === 'number') append(out, [], v);else out[k] = clone(v);
  }
  return out;
}
/** Replace keys without reindexing numeric entries. */
function array_replace(...values) {
  const out = [];
  for (const value of values) for (const [k, v] of entries(value)) out[k] = clone(v);
  return out;
}
/** Produce safely quoted terminal arguments for a POSIX shell boundary. */
function escapeshellarg(value) {
  return "'" + string(value).replaceAll("'", "'\"'\"'") + "'";
}
/** Sort a map's own keys in place for canonical evidence. */
function ksort(value) {
  const sorted = Object.keys(value).sort().map(k => [k, value[k]]);
  for (const k of Object.keys(value)) delete value[k];
  for (const [k, v] of sorted) value[k] = v;
}
/** Limit delimited splitting while retaining the unsplit suffix. */
function explode(delimiter, text, limit) {
  const parts = string(text).split(delimiter);
  if (limit && parts.length > limit) return [...parts.slice(0, limit - 1), parts.slice(limit - 1).join(delimiter)];
  return parts;
}
/** Trim an explicit set of characters at a selected string edge. */
function trimCharacters(value, chars = ' \n\r\t\v\0', left = true, right = true) {
  let s = string(value),
    start = 0,
    end = s.length;
  if (left) while (start < end && chars.includes(s[start])) start++;
  if (right) while (end > start && chars.includes(s[end - 1])) end--;
  return s.slice(start, end);
}
/** Validate scalar and collection boundaries before applying workflow logic. */
function assertType(value, type, label) {
  if (type[0] === '?') {
    if (value === null) return;
    type = type.slice(1);
  }
  const valid = type === 'array' ? value !== null && typeof value === 'object' : type === 'int' ? Number.isSafeInteger(value) : type === 'float' ? (typeof value === 'number' || value instanceof Number) && Number.isFinite(Number(value)) : type === 'callable' ? typeof callable(value) === 'function' : typeof value === ({
    bool: 'boolean',
    string: 'string'
  }[type] ?? type);
  if (!valid) throw new Error('Invalid ' + type + ' field: ' + label);
}
const api = {
  assertType,
  requireNode,
  truth,
  get,
  clone,
  equal,
  add,
  set,
  append,
  entries,
  entriesArray,
  object,
  array,
  string,
  integer,
  jsonValue,
  json_encode,
  json_decode,
  fail,
  usleep,
  atomicWrite,
  processResult,
  lockedCommand,
  regex,
  preg_match,
  preg_match_all,
  callable,
  array_map,
  array_filter,
  array_merge,
  array_replace,
  escapeshellarg,
  ksort,
  explode,
  is_array: v => v !== null && typeof v === 'object' && !(v instanceof Number),
  is_string: v => typeof v === 'string',
  is_bool: v => typeof v === 'boolean',
  is_int: Number.isSafeInteger,
  array_is_list: v => Array.isArray(v) && Object.keys(v).every((k, i) => k === String(i)),
  array_key_exists: (k, v) => Object.hasOwn(v, k),
  array_keys: v => entries(v).map(([k]) => k),
  array_values: v => Object.values(v),
  array_key_first: v => entries(v)[0]?.[0] ?? null,
  array_diff: (a, b) => Object.values(a).filter(x => !Object.values(b).some(y => equal(x, y))),
  in_array: (x, v) => Object.values(v).some(y => equal(x, y)),
  array_search: (x, v) => entries(v).find(([, y]) => equal(x, y))?.[0] ?? false,
  array_combine: (a, b) => Object.fromEntries(Object.values(a).map((k, i) => [k, Object.values(b)[i]])),
  array_flip: v => Object.fromEntries(entries(v).map(([k, x]) => [x, k])),
  array_intersect_key: (a, b) => Object.fromEntries(entries(a).filter(([k]) => Object.hasOwn(b, k))),
  array_column: (a, k) => Object.values(a).map(x => x[k]),
  array_slice: (a, start, length) => Object.values(a).slice(start, length === undefined ? undefined : start + length),
  array_pop: a => a.pop(),
  array_push: (a, ...v) => a.push(...v),
  array_reverse: a => Object.values(a).reverse(),
  array_splice: (a, offset, length, replacement = []) => a.splice(offset, length, ...replacement),
  reset: a => Object.values(a)[0],
  range: (a, b) => Array.from({
    length: b - a + 1
  }, (_, i) => a + i),
  count: v => Object.keys(v).length,
  strlen: s => Buffer.byteLength(s),
  strval: string,
  strtolower: s => s.toLowerCase(),
  str_contains: (s, x) => s.includes(x),
  str_starts_with: (s, x) => s.startsWith(x),
  strrpos: (s, x) => s.lastIndexOf(x) < 0 ? false : s.lastIndexOf(x),
  substr: (s, start, length) => length === undefined ? s.slice(start) : length < 0 ? s.slice(start, length) : s.slice(start, start + length),
  str_replace: (a, b, s) => s.split(a).join(b),
  strtr: (s, m) => s.replace(new RegExp(Object.keys(m).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'), x => m[x]),
  strpbrk: (s, chars) => {
    const i = [...s].findIndex(x => chars.includes(x));
    return i < 0 ? false : s.slice(i);
  },
  implode: (sep, a) => Object.values(a).join(sep),
  trim: (s, ch) => trimCharacters(s, ch),
  ltrim: (s, ch) => trimCharacters(s, ch, true, false),
  rtrim: (s, ch) => trimCharacters(s, ch, false, true),
  ctype_digit: s => typeof s === 'string' && /^\d+$/.test(s),
  preg_quote: s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'),
  preg_split: (p, s) => s.split(regex(p)),
  basename: path.basename,
  dirname: (s, levels = 1) => {
    while (levels-- > 0) s = path.dirname(s);
    return s;
  },
  realpath,
  file_get_contents,
  is_link: s => statCheck(s, 'isSymbolicLink'),
  is_file: s => {
    try {
      return fs.statSync(s).isFile();
    } catch {
      return false;
    }
  },
  is_dir: s => {
    try {
      return fs.statSync(s).isDirectory();
    } catch {
      return false;
    }
  },
  is_readable: s => access(s, fs.constants.R_OK),
  is_executable: s => access(s, fs.constants.X_OK),
  file_exists: fs.existsSync,
  fileowner: s => {
    try {
      return fs.statSync(s).uid;
    } catch {
      return false;
    }
  },
  readlink: s => {
    try {
      return fs.readlinkSync(s);
    } catch {
      return false;
    }
  },
  tempnam,
  file_put_contents: (s, data) => {
    try {
      fs.writeFileSync(s, data);
      return Buffer.byteLength(data);
    } catch {
      return false;
    }
  },
  rename: (a, b) => {
    try {
      fs.renameSync(a, b);
      return true;
    } catch {
      return false;
    }
  },
  unlink: s => {
    fs.unlinkSync(s);
    return true;
  },
  rmdir: s => {
    fs.rmdirSync(s);
    return true;
  },
  mkdir: (s, mode = 0o777) => {
    try {
      fs.mkdirSync(s, {
        mode
      });
      return true;
    } catch {
      return false;
    }
  },
  scandir: s => ['.', '..', ...fs.readdirSync(s)],
  glob: pattern => {
    const dir = path.dirname(pattern),
      name = path.basename(pattern);
    return fs.readdirSync(dir).filter(x => new RegExp('^' + name.replace('[0-9]', '\\d').replaceAll('*', '.*') + '$').test(x)).map(x => path.join(dir, x));
  },
  getcwd: process.cwd,
  getmypid: () => process.pid,
  getenv: k => k === undefined ? {
    ...process.env
  } : process.env[k] ?? false,
  sys_get_temp_dir: os.tmpdir,
  hash: (algorithm, data) => crypto.createHash(algorithm).update(data).digest('hex'),
  hash_file: (algorithm, p) => crypto.createHash(algorithm).update(fs.readFileSync(p)).digest('hex'),
  hash_equals: (a, b) => a === b,
  random_bytes: crypto.randomBytes,
  bin2hex: b => b.toString('hex'),
  gmdate: () => new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'),
  time: () => Math.floor(Date.now() / 1000),
  microtime: () => Date.now() / 1000,
  sleep: s => usleep(s * 1e6),
  intdiv: (a, b) => Math.trunc(a / b),
  floor: Math.floor,
  round: Math.round,
  abs: Math.abs,
  max: Math.max,
  min: Math.min,
  exit: code => process.exit(code),
  JSON_THROW_ON_ERROR: 0,
  JSON_UNESCAPED_SLASHES: 64,
  JSON_INVALID_UTF8_SUBSTITUTE: 0,
  JSON_PRETTY_PRINT: 2,
  GLOB_ONLYDIR: 1,
  PREG_SET_ORDER: 2,
  DIRECTORY_SEPARATOR: path.sep,
  NODE_BINARY: process.execPath,
  STDIN: 0,
  stream_get_contents: fd => fs.readFileSync(fd, 'utf8'),
  STDOUT: 1,
  STDERR: 2,
  SIGINT: 'SIGINT',
  LOCK_EX: 2,
  LOCK_UN: 8,
  argv: process.argv.slice(1),
  _SERVER: {
    SCRIPT_FILENAME: process.argv[1]
  },
  function_exists: () => false
};
Object.assign(exports, api);
