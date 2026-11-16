#!/usr/bin/env node
// Stand-in for the system `ssh` in tests. Runs the remote command locally with
// HOME=$FAKE_REMOTE_HOME, and emulates `-N -L` with a TCP forwarder.
// Every invocation's argv is appended (JSON) to $FAKE_SSH_LOG.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';

const argv = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(argv) + '\n');

const withValue = new Set(['-o', '-i', '-L', '-p', '-l', '-S', '-F', '-J']);
let forward = null;
let noCmd = false;
let i = 0;
for (; i < argv.length; i++) {
  const a = argv[i];
  if (withValue.has(a)) { if (a === '-L') forward = argv[i + 1]; i++; continue; }
  if (a === '-N') { noCmd = true; continue; }
  if (a.startsWith('-')) continue;
  break;
}
const host = argv[i];
const command = argv.slice(i + 1).join(' ');

if (process.env.FAKE_SSH_FAIL === 'auth' || host === 'denied-host') {
  process.stderr.write(`${host}: Permission denied (publickey).\n`);
  process.exit(255);
}

if (noCmd && forward) {
  const [, lp, , rp] = forward.split(':');
  const srv = createServer((sock) => {
    const up = connect(Number(rp), '127.0.0.1');
    sock.pipe(up).pipe(sock);
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  srv.on('error', () => {
    process.stderr.write(`bind [127.0.0.1]:${lp}: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: ${lp}\nCould not request local forwarding.\n`);
    process.exit(255);
  });
  srv.listen(Number(lp), '127.0.0.1');
  process.on('SIGTERM', () => process.exit(0));
} else {
  const child = spawn('sh', ['-c', command], {
    stdio: 'inherit',
    env: { ...process.env, HOME: process.env.FAKE_REMOTE_HOME, SHELL: '/bin/sh' },
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}
