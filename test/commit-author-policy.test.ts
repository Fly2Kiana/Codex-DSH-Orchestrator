import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAINTAINER, validateCoauthors, validateCommit, validateCommits, validatePullRequest } from '../.github/scripts/commit-author-policy.mjs';

const owner = () => ({
  sha: 'a'.repeat(40), author: { login: MAINTAINER.login, id: MAINTAINER.id },
  commit: { author: { name: MAINTAINER.name, email: MAINTAINER.email }, message: 'Reviewed maintainer integration\n\nSource: Dependabot PR #12' },
});
const pr = () => ({ user: { login: MAINTAINER.login, id: MAINTAINER.id }, commits: 1, title: 'Reviewed update', body: 'Preserves the original source PR.' });

test('author policy accepts the canonical maintainer and normal source provenance', () => {
  assert.doesNotThrow(() => validateCommit(owner()));
  assert.doesNotThrow(() => validatePullRequest(pr(), [owner()]));
});
test('author policy rejects a matching display name with a different email', () => {
  const commit = owner(); commit.commit.author.email = 'other@example.invalid';
  assert.throws(() => validateCommit(commit), /unauthorized_commit_author/);
});
test('author policy rejects actual Dependabot author metadata', () => {
  const commit = owner(); commit.author = { login: 'dependabot[bot]', id: 49699333 };
  commit.commit.author = { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' };
  assert.throws(() => validateCommit(commit), /unauthorized_commit_author/);
});
test('author policy rejects another account and a forged owner account ID', () => {
  const commit = owner(); commit.author.id = 1;
  assert.throws(() => validateCommit(commit), /unauthorized_commit_author/);
  commit.author = { login: 'other', id: MAINTAINER.id };
  assert.throws(() => validateCommit(commit), /unauthorized_commit_author/);
});
test('author policy rejects missing linked GitHub author metadata', () => {
  const commit = owner(); commit.author = null;
  assert.throws(() => validateCommit(commit), /unauthorized_commit_author/);
});
test('author policy accepts an exact maintainer coauthor and rejects other coauthors', () => {
  assert.doesNotThrow(() => validateCoauthors(`Reviewed\n\nCo-authored-by: ${MAINTAINER.name} <${MAINTAINER.email}>`));
  assert.throws(() => validateCoauthors('Reviewed\n\nCo-authored-by: Other <other@example.invalid>'), /unauthorized_coauthor/);
  assert.throws(() => validateCoauthors('Reviewed\r\n\r\n  cO-AuThOrEd-By: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>'), /unauthorized_coauthor/);
});
test('author policy fails closed on malformed coauthor trailers or missing messages', () => {
  assert.throws(() => validateCoauthors('Co-authored-by: unknown'), /unauthorized_coauthor/);
  assert.throws(() => validateCoauthors(undefined), /missing_commit_message/);
});
test('author policy rejects a foreign PR creator even with owner-authored commits', () => {
  const request = pr(); request.user = { login: 'other', id: 2 };
  assert.throws(() => validatePullRequest(request, [owner()]), /unauthorized_pr_author/);
});
test('author policy checks prospective squash title and body attribution', () => {
  const request = pr(); request.body = 'Reviewed\n\nCo-authored-by: Other <other@example.invalid>';
  assert.throws(() => validatePullRequest(request, [owner()]), /unauthorized_coauthor/);
});
test('author policy refuses incomplete or empty commit metadata', () => {
  assert.throws(() => validateCommits([], 1), /incomplete_commit_list/);
  assert.throws(() => validateCommits([owner()], 2), /incomplete_commit_list/);
  const request = pr(); request.commits = 0;
  assert.throws(() => validatePullRequest(request, []), /missing_commit_count/);
});
