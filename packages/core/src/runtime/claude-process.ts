import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface SpawnSpec {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const MAX_LINE = 4 * 1024 * 1024;

/**
 * One long-lived `claude -p --input-format stream-json` process.
 * Emits: 'line' (raw stdout JSONL line), 'exit' (code, signal) exactly once.
 */
export class ClaudeProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private exited = false;
  readonly stderrTail: string[] = [];
  readonly spec: SpawnSpec;
  sawOutput = false;

  constructor(spec: SpawnSpec) {
    super();
    this.spec = spec;
  }

  get pid(): number | null { return this.child?.pid ?? null; }
  get alive(): boolean { return !!this.child && !this.exited; }

  start(): void {
    const child = spawn(this.spec.bin, this.spec.args, {
      cwd: this.spec.cwd,
      env: this.spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      this.sawOutput = true;
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line) this.emit('line', line);
      }
      if (this.buf.length > MAX_LINE) this.buf = ''; // runaway line; drop it
    });
    child.stderr.on('data', (chunk: string) => {
      for (const l of chunk.split('\n')) {
        if (!l.trim()) continue;
        this.stderrTail.push(l);
        if (this.stderrTail.length > 30) this.stderrTail.shift();
      }
    });
    child.stdin.on('error', () => { /* EPIPE when process died; exit handler covers it */ });
    child.on('error', (err) => {
      this.stderrTail.push(String(err.message));
      this.finish(null, null);
    });
    // 'close' (not 'exit') so stdout/stderr are fully drained before we report the exit.
    child.on('close', (code, signal) => {
      // Flush trailing partial line.
      const rest = this.buf.trim();
      this.buf = '';
      if (rest) this.emit('line', rest);
      this.finish(code, signal);
    });
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }

  send(obj: unknown): boolean {
    if (!this.child || this.exited || !this.child.stdin.writable) return false;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  /** Close stdin: claude finishes the current turn (if any) and exits cleanly. */
  endInput(): void {
    if (this.child && !this.exited && this.child.stdin.writable) this.child.stdin.end();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.child && !this.exited) {
      try { this.child.kill(signal); } catch { /* already gone */ }
    }
  }
}
