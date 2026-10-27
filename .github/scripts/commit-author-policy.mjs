import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAINTAINER = Object.freeze({
  login: 'Fly2Kiana',
  id: 171018150,
  name: 'Fly2Kiana',
  email: '171018150+Fly2Kiana@users.noreply.github.com',
});
export const STATUS_CONTEXT = 'Maintainer author policy';
const REPOSITORY = 'Fly2Kiana/Codex-DSH-Orchestrator';

export function validateCoauthors(message) {
  if (typeof message !== 'string') throw new Error('missing_commit_message');
  for (const line of message.split(/\r?\n/)) {
    if (!/^\s*co-authored-by\s*:/i.test(line)) continue;
    const match = /^\s*co-authored-by\s*:\s*([^<>]+?)\s*<([^<>\s]+)>\s*$/i.exec(line);
    if (!match || match[1] !== MAINTAINER.name || match[2] !== MAINTAINER.email) {
      throw new Error('unauthorized_coauthor');
    }
  }
}

export function validateCommit(commit) {
  const author = commit?.commit?.author;
  if (author?.name !== MAINTAINER.name || author?.email !== MAINTAINER.email
      || commit?.author?.login !== MAINTAINER.login || commit?.author?.id !== MAINTAINER.id) {
    throw new Error('unauthorized_commit_author');
  }
  validateCoauthors(commit.commit.message);
}

export function validateCommits(commits, expectedCount) {
  if (!Array.isArray(commits) || commits.length === 0
      || (expectedCount !== undefined && commits.length !== expectedCount)) {
    throw new Error('incomplete_commit_list');
  }
  for (const commit of commits) validateCommit(commit);
}

export function validatePullRequest(pr, commits) {
  if (pr?.user?.login !== MAINTAINER.login || pr?.user?.id !== MAINTAINER.id) {
    throw new Error('unauthorized_pr_author');
  }
  if (!Number.isSafeInteger(pr.commits) || pr.commits < 1) throw new Error('missing_commit_count');
  validateCommits(commits, pr.commits);
  validateCoauthors(pr.title);
  validateCoauthors(pr.body ?? '');
}

async function runPolicy() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const isPr = process.env.GITHUB_EVENT_NAME === 'pull_request_target';
  if ((!isPr && process.env.GITHUB_EVENT_NAME !== 'push')
      || process.env.GITHUB_REPOSITORY !== REPOSITORY || event.repository?.full_name !== REPOSITORY) {
    throw new Error('unsupported_policy_context');
  }
  if (!isPr && process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('unsupported_main_ref');
  const sha = isPr ? event.pull_request?.head?.sha : event.after;
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('invalid_policy_sha');
  if (!process.env.GITHUB_TOKEN) throw new Error('missing_workflow_token');
  const runUrl = `https://github.com/${REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const request = async (path, body) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`github_api_${response.status}`);
        return await response.json();
      } catch (error) { lastError = error; }
    }
    throw lastError;
  };
  const status = (state, description) => request(`statuses/${sha}`, {
    state, description, context: STATUS_CONTEXT, target_url: runUrl,
  });
  const listCommits = async (path) => {
    const commits = [];
    for (let page = 1; page <= 100; page++) {
      const entries = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(entries)) throw new Error('invalid_commit_list');
      commits.push(...entries);
      if (entries.length < 100) return commits;
    }
    throw new Error('commit_scan_limit');
  };
  try {
    await status('pending', 'Checking approved author identity and coauthor trailers');
    let commits;
    if (isPr) {
      const number = event.pull_request?.number;
      if (!Number.isSafeInteger(number) || number < 1) throw new Error('invalid_pr_number');
      const pr = await request(`pulls/${number}`);
      if (pr.head.sha !== sha || pr.base.ref !== 'main') throw new Error('stale_pr_head');
      commits = await listCommits(`pulls/${number}/commits`);
      validatePullRequest(pr, commits);
      const latest = await request(`pulls/${number}`);
      if (latest.head.sha !== sha || latest.title !== pr.title || latest.body !== pr.body) {
        throw new Error('stale_pr_metadata');
      }
    } else {
      commits = await listCommits(`commits?sha=${sha}`);
      validateCommits(commits);
    }
    await status('success', 'Only the explicitly approved maintainer is attributed');
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `Author policy passed for ${commits.length} commits. Account ID, canonical noreply email and coauthor trailers checked.\n`);
    }
  } catch (error) {
    const reason = /^(unauthorized_|incomplete_|missing_|invalid_|stale_|commit_scan_limit|github_api_)/.test(error.message)
      ? error.message : 'author_policy_unavailable';
    try { await status('failure', reason); } catch { console.error('author_policy_status_unavailable'); }
    console.error(reason);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPolicy().catch(() => { console.error('author_policy_unavailable'); process.exitCode = 1; });
}
