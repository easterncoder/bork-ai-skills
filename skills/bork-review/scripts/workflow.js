'use strict';

const c = require("./support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };
let error, input;

/* Portable CLI mechanics. Input and output are one JSON object per invocation. */
/** Run a command without shell interpolation and capture its result. */
function command(args, cwd = null) {
  c.assertType(args, "array", "command.args");
  c.assertType(cwd, "?string", "command.cwd");
  const result = c.processResult(args, {
    cwd: cwd ?? undefined
  });
  if (result.error) throw new Error('Unable to start command.');
  return {
    code: result.code,
    output: result.output.replace(/[\r\n]+$/, '')
  };
}

/** Return successful Git output without echoing command arguments or credentials. */
function git(repo, args) {
  c.assertType(repo, "string", "git.repo");
  c.assertType(args, "array", "git.args");
  let result;
  repo = c.clone(repo);
  args = c.clone(args);
  result = c.clone(command(c.array_merge(["git", "-C", repo], args)));
  if (!c.equal(c.get(result, "code"), 0)) {
    throw new Error("Git operation failed; inspect locally before retrying.");
  }
  return c.get(result, "output");
}
/** Require a nonempty string parameter. */
function value(input, key) {
  c.assertType(input, "array", "value.input");
  c.assertType(key, "string", "value.key");
  input = c.clone(input);
  key = c.clone(key);
  if (!(c.get(input, key) != null) || !c.is_string(c.get(input, key)) || c.equal(c.get(input, key), "")) {
    throw new Error(c.string("Missing string field: ") + c.string(key));
  }
  return c.get(input, key);
}
/** Read a JSON object from a regular file. */
function readJson(path) {
  c.assertType(path, "string", "readJson.path");
  let data;
  path = c.clone(path);
  if (c.is_link(path) || !c.is_file(path)) {
    throw new Error("Expected regular JSON file.");
  }
  data = c.clone(c.json_decode(c.file_get_contents(path), true, 512, c.JSON_THROW_ON_ERROR));
  if (!c.is_array(data)) {
    throw new Error("Expected JSON object.");
  }
  return data;
}
/** Atomically publish content into an existing directory without following a target link. */
function atomicWrite(path, content) {
  c.assertType(path, "string", "atomicWrite.path");
  c.assertType(content, "string", "atomicWrite.content");
  c.atomicWrite(path, content);
}

/** Collect local identity and a compact fingerprint for change detection. */
function inspectRepo(repo) {
  c.assertType(repo, "string", "inspectRepo.repo");
  let root, status;
  repo = c.clone(repo);
  root = c.clone(git(repo, ["rev-parse", "--show-toplevel"]));
  status = c.clone(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"]));
  return c.entriesArray([["worktree", root], ["common_git_dir", git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])], ["branch", git(root, ["symbolic-ref", "--short", "HEAD"])], ["head", git(root, ["rev-parse", "HEAD"])], ["tree", git(root, ["rev-parse", "HEAD^{tree}"])], ["status_hash", c.hash("sha256", status)], ["clean_including_ignored", c.equal(status, "")], ["status_entries", c.equal(status, "") ? [] : c.explode("\u0000", c.rtrim(status, "\u0000"))]]);
}
/** Check the expected branch and commit immediately before a local action. */
function guard(input) {
  c.assertType(input, "array", "guard.input");
  let state;
  input = c.clone(input);
  state = c.clone(inspectRepo(value(input, "repo")));
  if (!c.equal(c.get(state, "branch"), value(input, "branch")) || !c.equal(c.get(state, "head"), value(input, "head"))) {
    throw new Error("Branch or HEAD changed.");
  }
  return state;
}
/** Poll a status file for at most fifty seconds without background processes. */
function waitStatus(input) {
  c.assertType(input, "array", "waitStatus.input");
  let deadline, path, remaining, seconds, state, valid, wanted;
  input = c.clone(input);
  path = c.clone(value(input, "path"));
  seconds = c.clone(c.max(0, c.min(50, c.integer(c.get(input, "seconds") ?? 50))));
  wanted = c.clone(c.get(input, "wanted") ?? ["good", "blocked"]);
  valid = c.clone(["coded", "reviewing", "reviewed", "coding", "good", "blocked"]);
  if (!c.is_array(wanted) || c.truth(c.array_diff(wanted, valid))) {
    throw new Error("Invalid wanted states.");
  }
  deadline = c.clone(c.add(c.microtime(true), seconds));
  do {
    if (c.is_link(path)) {
      throw new Error("Status must not be a symlink.");
    }
    state = c.clone(c.is_file(path) ? c.trim(c.file_get_contents(path)) : null);
    if (c.equal(state, null) && !c.truth(c.get(input, "allow_missing") ?? false)) {
      throw new Error("Status missing after initialization.");
    }
    if (!c.equal(state, null) && !c.in_array(state, valid, true)) {
      throw new Error("Invalid status.");
    }
    if (c.in_array(state, c.array_merge(wanted, ["good", "blocked"]), true)) {
      return c.entriesArray([["event", state]]);
    }
    remaining = c.clone(deadline - c.microtime(true));
    if (remaining <= 0) {
      return c.entriesArray([["event", "waiting"], ["state", state]]);
    }
    c.usleep(c.integer(c.min(10, remaining) * 1000000));
  } while (true);
}
/** Compare complete, caller-normalized maps and return only changed entries. */
function delta(input) {
  c.assertType(input, "array", "delta.input");
  let changed, entry, key, newValue, old, removed;
  input = c.clone(input);
  old = c.clone(readJson(value(input, "previous")));
  newValue = c.clone(readJson(value(input, "current")));
  changed = c.clone([]);
  for (const [_key, _value] of c.entries(newValue)) {
    key = _key;
    entry = c.clone(_value);
    {
      if (!c.array_key_exists(key, old) || !c.equal(c.get(old, key), entry)) {
        c.set(changed, [key], "=", entry);
      }
    }
  }
  removed = c.clone(c.array_values(c.array_diff(c.array_keys(old), c.array_keys(newValue))));
  return c.entriesArray([["event", c.truth(changed) || c.truth(removed) ? "changed" : "unchanged"], ["changed", c.object(changed)], ["removed", removed]]);
}
/** Publish a role-owned status transition after checking the session and Git identity. */
function transition(input) {
  c.assertType(input, "array", "transition.input");
  let actual, allowed, from, mutex, path, repo, role, session, state, to;
  input = c.clone(input);
  repo = c.clone(value(input, "repo"));
  state = c.clone(guard(input));
  session = c.clone(readJson(value(input, "session")));
  if (!c.equal(c.get(session, "run_id") ?? null, value(input, "run_id")) || !c.equal(c.realpath(c.get(session, "worktree") ?? ""), c.realpath(repo))) {
    throw new Error("Session identity mismatch.");
  }
  from = c.clone(value(input, "from"));
  to = c.clone(value(input, "to"));
  role = c.clone(value(input, "role"));
  allowed = c.clone(c.entriesArray([["review", ["coded:reviewing", "coded:blocked", "reviewing:reviewed", "reviewing:good", "reviewing:blocked"]], ["fix", ["reviewed:coding", "reviewed:blocked", "coding:coded", "coding:blocked"]], ["owner", ["missing:coded", "good:coded"]]]));
  if (!c.in_array(c.string(c.string(from) + c.string(":")) + c.string(to), c.get(allowed, role) ?? [], true)) {
    throw new Error("Transition is not owned by this role.");
  }
  path = c.clone(c.string(c.string(c.get(state, "worktree")) + c.string(c.DIRECTORY_SEPARATOR)) + c.string(".status"));
  mutex = c.clone(c.string(path) + c.string(".lock"));
  if (!c.truth(c.mkdir(mutex, 448))) {
    throw new Error("Transition lock exists; reconcile before retrying.");
  }
  try {
    if (c.is_link(path)) {
      throw new Error("Status must not be a symlink.");
    }
    actual = c.clone(c.is_file(path) ? c.trim(c.file_get_contents(path)) : "missing");
    if (!c.equal(actual, from)) {
      throw new Error("Status changed before handoff.");
    }
    guard(input);
    atomicWrite(path, c.string(to) + c.string("\n"));
  } finally {
    c.rmdir(mutex);
  }
  return c.entriesArray([["event", to]]);
}
/** Acquire or release a lock only with the recorded opaque owner token. */
function lockAction(input) {
  c.assertType(input, "array", "lockAction.input");
  let path, token;
  input = c.clone(input);
  path = c.clone(value(input, "path"));
  token = c.clone(value(input, "token"));
  if (c.equal(c.get(input, "operation") ?? "acquire", "acquire")) {
    if (!c.truth(c.mkdir(path, 448))) {
      throw new Error("Lock already exists or parent unavailable.");
    }
    atomicWrite(c.string(path) + c.string("/owner.json"), c.json_encode(c.entriesArray([["token", token]]), c.JSON_THROW_ON_ERROR));
    return c.entriesArray([["event", "acquired"]]);
  }
  if (!c.equal(c.get(input, "operation") ?? "", "release") || c.is_link(path)) {
    throw new Error("Invalid lock operation.");
  }
  if (!c.equal(c.get(readJson(c.string(path) + c.string("/owner.json")), "token") ?? null, token)) {
    throw new Error("Lock owner mismatch.");
  }
  if (!c.equal(c.count(c.scandir(path)), 3)) {
    throw new Error("Unexpected lock contents.");
  }
  c.unlink(c.string(path) + c.string("/owner.json"));
  if (!c.truth(c.rmdir(path))) {
    throw new Error("Lock removal failed.");
  }
  return c.entriesArray([["event", "released"]]);
}
/** Verify only the specified new commit range, including author and signatures. */
function verifyCommits(input) {
  c.assertType(input, "array", "verifyCommits.input");
  let base, commits, email, head, repo, sha, verified;
  input = c.clone(input);
  repo = c.clone(value(input, "repo"));
  base = c.clone(git(repo, ["rev-parse", "--verify", c.string(value(input, "base")) + c.string("^{commit}")]));
  head = c.clone(git(repo, ["rev-parse", "--verify", c.string(value(input, "head")) + c.string("^{commit}")]));
  if (!c.equal(c.get(command(["git", "-C", repo, "merge-base", "--is-ancestor", base, head]), "code"), 0)) {
    throw new Error("Commit range is not a forward history.");
  }
  commits = c.clone(git(repo, ["rev-list", c.string(c.string(base) + c.string("..")) + c.string(head)]));
  email = c.clone(c.get(input, "email") != null ? value(input, "email") : git(repo, ["config", "user.email"]));
  if (c.equal(email, "")) {
    throw new Error("Commit author email is required.");
  }
  verified = c.clone([]);
  for (const [_key, _value] of c.entries(c.equal(commits, "") ? [] : c.explode("\n", commits))) {
    sha = c.clone(_value);
    {
      if (!c.equal(git(repo, ["show", "-s", "--format=%ae", sha]), email) || !c.equal(c.get(command(["git", "-C", repo, "verify-commit", sha]), "code"), 0)) {
        throw new Error(c.string("Commit signature or author verification failed: ") + c.string(sha));
      }
      c.append(verified, [], sha);
    }
  }
  return c.entriesArray([["event", "verified"], ["commits", verified]]);
}
/** Dispatch portable mechanics; semantic approvals remain the lifecycle owner's job. */
function dispatch(input) {
  c.assertType(input, "array", "dispatch.input");
  let base, branch, data, repo, state;
  input = c.clone(input);
  switch (value(input, "action")) {
    case "snapshot":
      return require("./evidence.js").snapshot(input);
    case "brief":
      return require("./evidence.js").buildBrief(input);
    case "record":
      return require("./evidence.js").appendRecord(input);
    case "reuse-review":
      return require("./evidence.js").reuseReview(input);
    case "automation-poll":
      return require("./automation.js").automationPoll(input);
    case "automation-assess":
      return require("./automation.js").automationAssess(input);
    case "inspect":
      return inspectRepo(value(input, "repo"));
    case "guard":
      return guard(input);
    case "wait":
      return waitStatus(input);
    case "delta":
      return delta(input);
    case "transition":
      return transition(input);
    case "lock":
      return lockAction(input);
    case "verify-commits":
      return verifyCommits(input);
    case "write":
      data = c.clone(c.get(input, "data") ?? null);
      if (!c.is_array(data)) {
        throw new Error("Data must be a JSON object or array.");
      }
      atomicWrite(value(input, "path"), c.string(c.json_encode(data, c.JSON_PRETTY_PRINT | c.JSON_UNESCAPED_SLASHES | c.JSON_THROW_ON_ERROR)) + c.string("\n"));
      return c.entriesArray([["event", "written"]]);
    case "worktree-create":
      repo = c.clone(value(input, "repo"));
      branch = c.clone(value(input, "branch"));
      git(repo, ["check-ref-format", "--branch", branch]);
      base = c.clone(git(repo, ["rev-parse", "--verify", c.string(value(input, "base")) + c.string("^{commit}")]));
      git(repo, ["worktree", "add", "-b", branch, value(input, "path"), base]);
      return c.entriesArray([["event", "created"], ["head", base]]);
    case "cleanup-check":
      state = c.clone(guard(input));
      return c.entriesArray([["event", c.truth(c.get(state, "clean_including_ignored")) ? "removable_locally" : "preserve"], ["entries", c.get(state, "status_entries")]]);
    default:
      throw new Error("Unknown action.");
  }
}
module.exports = {
  command,
  git,
  value,
  readJson,
  atomicWrite,
  inspectRepo,
  guard,
  waitStatus,
  delta,
  transition,
  lockAction,
  verifyCommits,
  dispatch
};
if (require.main === module) {
  try {
    input = c.clone(c.json_decode(c.stream_get_contents(c.STDIN), true, 512, c.JSON_THROW_ON_ERROR));
    if (!c.is_array(input)) {
      throw new Error("Expected JSON input object.");
    }
    process.stdout.write(c.string(c.string(c.json_encode(c.entriesArray([["ok", true], ["result", dispatch(input)]]), c.JSON_UNESCAPED_SLASHES | c.JSON_THROW_ON_ERROR)) + c.string("\n")));
  } catch (error) {
    process.stdout.write(c.string(c.string(c.json_encode(c.entriesArray([["ok", false], ["event", "blocked"], ["error", error.message]]), c.JSON_INVALID_UTF8_SUBSTITUTE)) + c.string("\n")));
    c.exit(1);
  }
}
