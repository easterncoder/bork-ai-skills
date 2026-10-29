'use strict';

const c = require("./support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };

/** Canonicalize maps without changing positional list ordering. */
function canonical(data) {
  data = c.clone(data);
  if (!c.is_array(data)) {
    return data;
  }
  if (!c.equal(data, []) && !c.equal(c.array_keys(data), c.range(0, c.count(data) - 1))) {
    c.ksort(data);
  }
  return c.array_map("canonical", data);
}
/** Hash evidence with deterministic map ordering. */
function evidenceHash(data) {
  data = c.clone(data);
  return c.hash("sha256", c.json_encode(canonical(data), c.JSON_UNESCAPED_SLASHES | c.JSON_THROW_ON_ERROR));
}
/** Read an explicit JSON path, rejecting missing evidence. */
function atPath(data, path) {
  c.assertType(data, "array", "atPath.data");
  c.assertType(path, "array", "atPath.path");
  let key, value;
  data = c.clone(data);
  path = c.clone(path);
  value = c.clone(data);
  for (const [_key, _value] of c.entries(path)) {
    key = c.clone(_value);
    {
      if (!c.is_array(value) || !c.array_key_exists(key, value)) {
        throw new Error("Missing evidence path.");
      }
      value = c.clone(c.get(value, key));
    }
  }
  return value;
}
/** Capture a read-only API call within a bounded wall-clock limit. */
function fetchCommand(args, seconds) {
  c.assertType(args, "array", "fetchCommand.args");
  c.assertType(seconds, "int", "fetchCommand.seconds");
  const result = c.processResult(args, {
    timeout: seconds * 1000
  });
  if (result.error?.code === 'ETIMEDOUT') throw new Error('Evidence fetch timed out; preserve the last complete snapshot.');
  if (result.error || result.code !== 0) throw new Error('Evidence fetch failed; preserve the last complete snapshot.');
  return result.output;
}

/** Reject nested incomplete connections except the explicitly paginated connection. */
function checkConnections(data, paginatedPath, path = []) {
  c.assertType(data, "array", "checkConnections.data");
  c.assertType(paginatedPath, "array", "checkConnections.paginatedPath");
  c.assertType(path, "array", "checkConnections.path");
  let child, key;
  data = c.clone(data);
  paginatedPath = c.clone(paginatedPath);
  path = c.clone(path);
  if (c.get(data, "pageInfo") != null) {
    if (!c.is_array(c.get(data, "pageInfo")) || !c.is_bool(c.get(data, "pageInfo", "hasNextPage") ?? null)) {
      throw new Error("Invalid connection page information.");
    }
    if (c.truth(c.get(data, "pageInfo", "hasNextPage")) && !c.equal(path, paginatedPath)) {
      throw new Error("Nested connection is incomplete; fetch it separately.");
    }
  }
  for (const [_key, _value] of c.entries(data)) {
    key = _key;
    child = c.clone(_value);
    {
      if (c.is_array(child)) {
        checkConnections(child, paginatedPath, c.array_merge(path, [key]));
      }
    }
  }
}
/** Fetch a complete read-only source and retain raw and normalized snapshots. */
function snapshot(input) {
  c.assertType(input, "array", "snapshot.input");
  let args, changed, connection, destination, endpoint, entries, entry, graphql, host, id, identity, items, key, name, old, owner, page, pageIndex, pageInfo, pages, path, previous, query, raw, record, removed, repository, spec, variable;
  input = c.clone(input);
  spec = c.clone(require("./workflow.js").readJson(require("./workflow.js").value(input, "spec")));
  host = c.clone(require("./workflow.js").value(spec, "host"));
  repository = c.clone(require("./workflow.js").value(spec, "repository"));
  endpoint = c.clone(require("./workflow.js").value(spec, "endpoint"));
  if (!c.truth(c.preg_match("/^[a-zA-Z0-9.-]+$/", host)) || !c.truth(c.preg_match("~^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$~", repository))) {
    throw new Error("Invalid explicit repository identity.");
  }
  args = c.clone(["gh", "api", "--hostname", host, "--paginate", "--slurp"]);
  graphql = c.clone(c.equal(endpoint, "graphql"));
  if (c.truth(graphql)) {
    query = c.clone(require("./workflow.js").value(spec, "query"));
    if (!c.truth(c.preg_match("/^\\s*query\\b/", query)) || c.truth(c.preg_match("/\\bmutation\\b/i", query)) || !c.str_contains(query, "$owner") || !c.str_contains(query, "$name")) {
      throw new Error("Use an explicit read-only query binding owner and name.");
    }
    [owner, name] = c.clone(c.explode("/", repository));
    args = c.clone(c.array_merge(args, ["graphql", "-f", c.string("query=") + c.string(query), "-f", c.string("owner=") + c.string(owner), "-f", c.string("name=") + c.string(name)]));
    for (const [_key, _value] of c.entries(c.get(spec, "variables") ?? [])) {
      key = _key;
      variable = c.clone(_value);
      {
        if (c.in_array(key, ["owner", "name", "query", "endCursor"], true) || !c.truth(c.preg_match("/^[a-zA-Z][a-zA-Z0-9_]*$/", key)) || !c.is_string(variable) && !c.is_int(variable)) {
          throw new Error("Invalid query variable.");
        }
        args = c.clone(c.array_merge(args, [c.is_int(variable) ? "-F" : "-f", c.string(c.string(key) + c.string("=")) + c.string(variable)]));
      }
    }
  } else {
    if (!c.str_starts_with(endpoint, c.string(c.string("repos/") + c.string(repository)) + c.string("/")) || c.str_contains(endpoint, "..") || c.str_contains(endpoint, "%")) {
      throw new Error("Endpoint must address the recorded repository.");
    }
    args = c.clone(c.array_merge(args, ["--method", "GET", endpoint]));
  }
  raw = c.clone(fetchCommand(args, c.max(1, c.min(40, c.integer(c.get(input, "seconds") ?? 20)))));
  pages = c.clone(c.json_decode(raw, true, 512, c.JSON_THROW_ON_ERROR));
  if (!c.is_array(pages) || !c.truth(pages)) {
    throw new Error("Missing API pages.");
  }
  entries = c.clone([]);
  path = c.clone(c.get(spec, "items_path") ?? []);
  connection = c.clone(c.get(spec, "connection_path") ?? []);
  for (const [_key, _value] of c.entries(pages)) {
    pageIndex = _key;
    page = c.clone(_value);
    {
      if (!c.is_array(page) || c.get(page, "errors") != null || c.truth(graphql) && !(c.get(page, "data") != null)) {
        throw new Error("Incomplete API result.");
      }
      if (c.truth(graphql)) {
        checkConnections(page, connection);
        if (c.truth(connection)) {
          pageInfo = c.clone(atPath(page, c.array_merge(connection, ["pageInfo"])));
          if (!c.equal(c.get(pageInfo, "hasNextPage") ?? null, pageIndex < c.count(pages) - 1)) {
            throw new Error("Pagination did not reach a complete final page.");
          }
        }
      }
      items = c.clone(atPath(page, path));
      if (c.equal(c.get(spec, "single") ?? false, true)) {
        items = c.clone([items]);
      }
      if (!c.is_array(items)) {
        throw new Error("Expected source entries.");
      }
      for (const [_key, _value] of c.entries(items)) {
        entry = c.clone(_value);
        {
          if (!c.is_array(entry)) {
            throw new Error("Invalid source entry.");
          }
          id = c.clone(c.get(spec, "single_id") != null ? require("./workflow.js").value(spec, "single_id") : atPath(entry, c.get(spec, "id_path") ?? ["id"]));
          if (!c.is_string(id) && !c.is_int(id) || c.equal(c.string(id), "")) {
            throw new Error("Missing stable source ID.");
          }
          id = c.clone(c.string(id));
          entry = c.clone(canonical(entry));
          if (c.array_key_exists(id, entries) && !c.equal(c.get(entries, id), entry)) {
            throw new Error("Source changed during pagination; retry a complete fetch.");
          }
          c.set(entries, [id], "=", entry);
        }
      }
    }
  }
  c.ksort(entries);
  identity = c.clone(evidenceHash(spec));
  previous = c.clone(c.get(input, "previous") != null ? require("./workflow.js").readJson(require("./workflow.js").value(input, "previous")) : null);
  if (!c.equal(previous, null) && (!c.equal(c.get(previous, "complete") ?? false, true) || !c.equal(c.get(previous, "source_hash") ?? "", identity))) {
    throw new Error("Previous snapshot has different or incomplete source identity.");
  }
  old = c.clone(c.get(previous, "entries") ?? []);
  changed = c.clone([]);
  for (const [_key, _value] of c.entries(entries)) {
    id = _key;
    entry = c.clone(_value);
    {
      if (!c.array_key_exists(id, old) || !c.equal(c.get(old, id), entry)) {
        c.append(changed, [], c.string(id));
      }
    }
  }
  removed = c.clone(c.array_map("strval", c.array_values(c.array_diff(c.array_keys(old), c.array_keys(entries)))));
  destination = c.clone(require("./workflow.js").value(input, "path"));
  if (c.file_exists(destination) || c.is_link(destination) || c.file_exists(c.string(destination) + c.string(".raw.json")) || c.is_link(c.string(destination) + c.string(".raw.json"))) {
    throw new Error("Snapshot destination must be new.");
  }
  record = c.clone(c.entriesArray([["schema_version", 1], ["complete", true], ["source_hash", identity], ["fetched_at", c.gmdate("c")], ["entries_hash", evidenceHash(entries)], ["entries", c.object(entries)]]));
  require("./workflow.js").atomicWrite(c.string(destination) + c.string(".raw.json"), raw);
  require("./workflow.js").atomicWrite(destination, c.json_encode(record, c.JSON_UNESCAPED_SLASHES | c.JSON_THROW_ON_ERROR));
  return c.entriesArray([["event", c.equal(previous, null) || c.truth(changed) || c.truth(removed) ? "changed" : "unchanged"], ["path", destination], ["hash", c.get(record, "entries_hash")], ["changed_ids", changed], ["removed_ids", removed], ["count", c.count(entries)]]);
}
/** Build a role brief from saved identity and explicit phase fields. */
function buildBrief(input) {
  c.assertType(input, "array", "buildBrief.input");
  let brief, fields, key, overlay, session;
  input = c.clone(input);
  session = c.clone(require("./workflow.js").readJson(require("./workflow.js").value(input, "session")));
  overlay = c.clone(c.get(input, "data") ?? []);
  if (!c.is_array(overlay)) {
    throw new Error("Brief fields must be an object.");
  }
  for (const [_key, _value] of c.entries(["run_id", "worktree", "branch", "base_repository", "head_repository", "pr_url", "issue_url"])) {
    key = c.clone(_value);
    {
      if (c.get(session, key) != null && c.get(overlay, key) != null && !c.equal(c.get(session, key), c.get(overlay, key))) {
        throw new Error(c.string("Brief changes session identity: ") + c.string(key));
      }
    }
  }
  fields = c.clone(["run_id", "mode", "review_mode", "role", "worktree", "branch", "head", "base_sha", "base_repository", "head_repository", "pr_url", "issue_url", "cycle", "pass", "context_path", "review_path", "previous_review_path", "instruction_paths", "validation_path", "execution_driver", "master_agent_id", "cli_profile", "master_pane", "commit_email", "base_override", "baseline_path", "worker_session_id"]);
  brief = c.clone(c.entriesArray([["schema_version", 1], ["session_path", require("./workflow.js").value(input, "session")]]));
  for (const [_key, _value] of c.entries(fields)) {
    key = c.clone(_value);
    {
      c.set(brief, [key], "=", c.get(overlay, key) ?? c.get(session, key) ?? null);
    }
  }
  for (const [_key, _value] of c.entries(["run_id", "role", "worktree", "branch", "head", "base_sha", "base_repository", "head_repository"])) {
    key = c.clone(_value);
    {
      require("./workflow.js").value(brief, key);
    }
  }
  if (!c.in_array(c.get(brief, "role"), ["review", "fix", "prify", "target_master"], true) || !c.truth(c.get(brief, "pr_url")) && !c.truth(c.get(brief, "issue_url"))) {
    throw new Error("Invalid role or missing target.");
  }
  require("./workflow.js").atomicWrite(require("./workflow.js").value(input, "path"), c.json_encode(brief, c.JSON_UNESCAPED_SLASHES | c.JSON_THROW_ON_ERROR));
  return c.entriesArray([["event", "written"], ["path", require("./workflow.js").value(input, "path")]]);
}
/** Append idempotent outcomes under a lock while retaining previous attempts. */
function appendRecord(input) {
  c.assertType(input, "array", "appendRecord.input");
  let data, id, lock, path, records;
  input = c.clone(input);
  path = c.clone(require("./workflow.js").value(input, "path"));
  id = c.clone(require("./workflow.js").value(input, "id"));
  data = c.clone(c.get(input, "data") ?? null);
  if (!c.is_array(data)) {
    throw new Error("Record data must be an object.");
  }
  lock = c.clone(c.string(path) + c.string(".lock"));
  if (!c.truth(c.mkdir(lock, 448))) {
    throw new Error("Record is locked; reconcile before retrying.");
  }
  try {
    records = c.clone(c.file_exists(path) ? require("./workflow.js").readJson(path) : []);
    if (c.array_key_exists(id, records)) {
      if (!c.equal(canonical(c.get(records, id)), canonical(data))) {
        throw new Error("Outcome already recorded; use a new attempt ID.");
      }
      return c.entriesArray([["event", "unchanged"], ["path", path], ["id", id]]);
    }
    c.set(records, [id], "=", data);
    require("./workflow.js").atomicWrite(path, c.json_encode(c.object(records), c.JSON_UNESCAPED_SLASHES | c.JSON_THROW_ON_ERROR));
  } finally {
    c.rmdir(lock);
  }
  return c.entriesArray([["event", "recorded"], ["path", path], ["id", id]]);
}
/** Identify candidate review reuse without granting review acceptance. */
function reuseReview(input) {
  c.assertType(input, "array", "reuseReview.input");
  let baseline, head, key, newValue, old, repo;
  input = c.clone(input);
  old = c.clone(require("./workflow.js").readJson(require("./workflow.js").value(input, "previous")));
  newValue = c.clone(require("./workflow.js").readJson(require("./workflow.js").value(input, "current")));
  for (const [_key, _value] of c.entries(["pr_url", "base_repository", "head_repository", "base_sha", "instruction_hash", "intent_hash"])) {
    key = c.clone(_value);
    {
      if (!c.truth(c.get(old, key)) || !c.truth(c.get(newValue, key)) || !c.equal(c.get(old, key), c.get(newValue, key))) {
        return c.entriesArray([["event", "full_review"], ["reason", c.string("changed_or_missing_") + c.string(key)]]);
      }
    }
  }
  if (!c.equal(c.get(old, "complete") ?? false, true) || !c.equal(c.get(newValue, "context_complete") ?? false, true) || !c.truth(c.get(old, "review_path")) || !c.is_file(c.get(old, "review_path"))) {
    return c.entriesArray([["event", "full_review"], ["reason", "missing_coverage_or_context"]]);
  }
  repo = c.clone(require("./workflow.js").value(input, "repo"));
  head = c.clone(require("./workflow.js").value(newValue, "head"));
  baseline = c.clone(require("./workflow.js").value(old, "reviewed_head"));
  require("./workflow.js").guard(c.entriesArray([["repo", repo], ["branch", require("./workflow.js").value(newValue, "branch")], ["head", head]]));
  if (!c.equal(require("./workflow.js").git(repo, ["status", "--porcelain=v1", "--untracked-files=no"]), "")) {
    return c.entriesArray([["event", "full_review"], ["reason", "dirty_tracked_content"]]);
  }
  if (!c.equal(c.get(require("./workflow.js").command(["git", "-C", repo, "merge-base", "--is-ancestor", baseline, head]), "code"), 0)) {
    return c.entriesArray([["event", "full_review"], ["reason", "missing_or_diverged_baseline"]]);
  }
  return c.entriesArray([["event", c.equal(baseline, head) ? "reuse_candidate" : "delta_candidate"], ["review_path", c.get(old, "review_path")], ["reviewed_head", baseline], ["reason", "identity_and_context_match"]]);
}
module.exports = {
  canonical,
  evidenceHash,
  atPath,
  fetchCommand,
  checkConnections,
  snapshot,
  buildBrief,
  appendRecord,
  reuseReview
};
