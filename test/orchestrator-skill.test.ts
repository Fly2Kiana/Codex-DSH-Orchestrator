import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("codex-dsh-orchestrator packages the approved global orchestration contract", async () => {
  const [skill, metadata] = await Promise.all([
    readFile(new URL("skill/codex-dsh-orchestrator/SKILL.md", root), "utf8"),
    readFile(new URL("skill/codex-dsh-orchestrator/agents/openai.yaml", root), "utf8"),
  ]);

  const frontmatterMatch = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---/.exec(skill);
  assert.notEqual(frontmatterMatch, null, "orchestrator skill must have YAML frontmatter");
  const frontmatter = frontmatterMatch?.groups?.frontmatter ?? "";
  const frontmatterKeys = [...frontmatter.matchAll(/^([a-z0-9-]+):/gm)].map((match) => match[1]);
  assert.deepEqual(frontmatterKeys, ["name", "description"]);
  const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? "";
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? "";
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(name.length <= 64);
  assert.ok(description.length > 0 && description.length <= 1024);
  assert.equal(/[<>]/.test(description), false);
  assert.equal(skill.includes("TODO"), false);
  assert.ok(skill.split(/\r?\n/).length < 500);

  for (const phrase of [
    "name: codex-dsh-orchestrator",
    "$codex-dsh-orchestrator",
    "请委派给 DSH",
    "Principal Agent",
    "Worker",
    "Keep small tasks in Codex",
    "The user's explicit route choice always wins",
    "modelProfile=\"flash\"",
    "modelProfile=\"pro\"",
    "modelProfile=\"modlens-flash\"",
    "modelProfile=\"modlens-pro\"",
    "visualIntent=\"required\"",
    "is never a first visual choice",
    "collapsed Code Mode",
    "top-level `run_code`",
    "tools.modlens_read_image",
    "exact underlying error",
    "one or two quiet wait windows are not a failure signal",
    "Never use a locally documented nested-tool timeout as the outer delegation deadline",
    "reasoningEffort",
    "selectionReason",
    "persists the selection as DSH's global default",
    "compact handoff",
    "read the focus paths first",
    "Never include secrets",
    "dsh_host_status",
    "dsh_delegate",
    "dsh_followup",
    "dsh_find_sessions",
    "dsh_attach_session",
    "dsh_wait",
    "dsh_tail",
    "dsh_answer_question",
    "dsh_resolve_approval",
    "Never auto-approve",
    "exclusive-write",
    "dsh_release_workspace",
    "Codex independently reviews",
    "never start, stop, or restart",
  ]) {
    assert.equal(skill.includes(phrase), true, `orchestrator skill lost required phrase: ${phrase}`);
  }

  for (const forbidden of [
    "dsh plugin --profile",
    "automatically read the Codex conversation",
    "automatically approve",
    "expiry of the known tool timeout as failure",
    "when ordinary visual evidence is essential",
  ]) {
    assert.equal(skill.includes(forbidden), false, `orchestrator skill contains forbidden behavior: ${forbidden}`);
  }

  for (const reuse of [
    /same-known-task/,
    /attached-existing-task/,
    /new-session/,
    /exact canonical cwd/is,
    /mapped.*idle.*unique/is,
    /merely similar.*must not/is,
    /provider cache.*not.*proven/is,
  ]) {
    assert.match(skill, reuse, "orchestrator skill lost reuse contract: " + reuse);
  }

  for (const reuseBoundary of [
    /mappedOnly/,
    /idleOnly/,
    /exactly one unique/,
    /providerCacheEvidence=not_exposed/,
    /increase input tokens/i,
    /same root/i,
    /never read history/i,
    /reacquire/i,
    /no model selection/i,
    /isolation/i,
  ]) {
    assert.match(skill, reuseBoundary, "orchestrator skill lost reuse boundary: " + reuseBoundary);
  }

  for (const phrase of [
    'display_name: "Codex DSH Orchestrator"',
    'short_description: "Orchestrate safe Codex-to-DSH worker delegation"',
    'default_prompt: "Use $codex-dsh-orchestrator to delegate suitable work to DSH and supervise it through final review."',
    "allow_implicit_invocation: true",
  ]) {
    assert.equal(metadata.includes(phrase), true, `orchestrator metadata lost required phrase: ${phrase}`);
  }
});
