import type { Server } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { loadConfig, VERSION, type NodeConfig } from './config.ts';
import { Store } from './store/db.ts';
import { EventBus } from './events.ts';
import { Projects } from './projects.ts';
import { AgentRuntime, type RuntimeOptions } from './runtime/agent-runtime.ts';
import { startServer } from './api/server.ts';
import { buildRouter } from './api/routes.ts';
import { Teams } from './teams/teams.ts';
import { installBin, knockSettings, type BinPaths } from './teams/bin.ts';
import { Watches, type WatchesOptions } from './watches/watches.ts';
import { InnerChat } from './innerchat/innerchat.ts';
import { agentToken } from './util/agent-token.ts';
import { Headless } from './journalist/headless.ts';
import { Journalist, type JournalistOptions } from './journalist/journalist.ts';
import { Rotator, type RotationConfig } from './rotation/rotator.ts';

/** One Axo node: store + runtime + API. Same code locally and on servers. */
export class Node {
  readonly cfg: NodeConfig;
  readonly store: Store;
  readonly bus: EventBus;
  readonly projects: Projects;
  readonly runtime: AgentRuntime;
  readonly headless: Headless;
  readonly journalist: Journalist;
  readonly rotator: Rotator;
  readonly bin: BinPaths;
  readonly teams: Teams;
  readonly watches: Watches;
  readonly innerchat: InnerChat;
  private server: Server | null = null;

  constructor(
    overrides: Partial<NodeConfig> = {},
    runtimeOpts: RuntimeOptions = {},
    dbFile?: string,
    extra: { journalist?: JournalistOptions; rotation?: Partial<RotationConfig>; watches?: WatchesOptions } = {},
  ) {
    this.cfg = loadConfig(overrides);
    this.store = new Store(this.cfg.home, dbFile);
    this.bus = new EventBus(this.cfg.nodeId);
    this.projects = new Projects(this.store, this.bus);
    this.runtime = new AgentRuntime(this.store, this.bus, this.cfg, this.projects, runtimeOpts);

    // Phase 2 coordination: axo CLI + knock hook on every agent's PATH/settings, per-agent token.
    this.bin = installBin(this.cfg.home);
    const settings = knockSettings(this.bin.knock);
    this.runtime.specHook = (a, spec) => {
      spec.args.push('--settings', settings);
      spec.env.PATH = `${this.bin.dir}${delimiter}${spec.env.PATH ?? ''}`;
      spec.env.AXO_TOKEN = agentToken(this.cfg.token, a.id);
    };
    this.watches = new Watches(this.store, this.bus, this.runtime, this.cfg.home, this.bin.dir, extra.watches);
    this.teams = new Teams({
      store: this.store, bus: this.bus, runtime: this.runtime,
      runSetup: (team, command) => {
        this.watches.create({ teamId: team.id, command, label: `setup: ${command}`, timeoutMs: 60 * 60_000 });
      },
    });
    this.innerchat = new InnerChat(this.store, this.bus, this.runtime);
    this.headless = new Headless(this.cfg);
    this.journalist = new Journalist(this.runtime, this.store, this.bus, this.headless, extra.journalist);
    this.rotator = new Rotator(this.runtime, this.journalist, this.headless, this.bus, this.cfg, extra.rotation);
    this.runtime.on('renamed', ({ agent, from }) => this.journalist.renameAgent(agent, from));
  }

  async start(): Promise<void> {
    this.runtime.startup();
    this.journalist.start();
    this.rotator.start();
    this.server = await startServer(this.cfg, this.bus, buildRouter(this), () => ({
      type: 'hello', nodeId: this.cfg.nodeId, version: VERSION, seq: this.bus.currentSeq, epoch: this.bus.epoch,
      ts: Date.now(),
    }) as any);
    const addr = this.server.address();
    if (addr && typeof addr === 'object') this.cfg.port = addr.port;
    this.watches.restore(); // after listen: a fired watch may spawn an agent, which needs the port
    writeFileSync(join(this.cfg.home, 'node.pid'), JSON.stringify({ pid: process.pid, port: this.cfg.port, version: VERSION }));
  }

  async stop(): Promise<void> {
    this.watches.stop();
    this.innerchat.stop();
    this.rotator.stop();
    this.journalist.stop();
    await this.runtime.shutdown();
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
    this.server?.closeAllConnections?.();
    this.store.close();
    rmSync(join(this.cfg.home, 'node.pid'), { force: true });
  }
}
