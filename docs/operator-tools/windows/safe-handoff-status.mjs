// Output allowlist only. Never print or persist raw caller/startup output.
const codes = new Set(['unsupported_platform', 'caller_preflight_failed', 'invalid_arguments',
  'startup_pipe_required', 'caller_already_running', 'handoff_failed', 'authorization_unavailable',
  'invalid_caller', 'caller_launch_failed', 'invalid_timeout', 'startup_timeout',
  'startup_closed', 'invalid_announcement', 'startup_output_limit', 'aborted']);
const seen = new Set();
let pending = '';
let oversized = false;
function line(value) {
  if (value.endsWith('\r')) value = value.slice(0, -1);
  let result;
  if (value === 'Authorized caller started; credential retained only in process memory. No Host RPC or model request was sent by this helper.') {
    result = 'caller_launch_requested';
  } else {
    const match = /^Local authorization handoff failed \(([a-z_]+)\); no credential or raw startup output is included$/.exec(value);
    if (match && codes.has(match[1])) result = 'failed: ' + match[1];
  }
  if (result && !seen.has(result)) {
    seen.add(result);
    process.stdout.write('[handoff] ' + result + '\n');
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  const pieces = chunk.split('\n');
  for (let i = 0; i < pieces.length; i++) {
    if (!oversized) {
      pending += pieces[i];
      if (pending.length > 8192) { pending = ''; oversized = true; }
    }
    if (i < pieces.length - 1) {
      if (!oversized) line(pending);
      pending = '';
      oversized = false;
    }
  }
});
process.stdin.on('end', () => { if (!oversized && pending) line(pending); });
process.stdin.on('error', () => process.stdout.write('[handoff] status_input_failed\n'));
