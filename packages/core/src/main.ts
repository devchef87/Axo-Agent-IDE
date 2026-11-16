import { Node } from './node.ts';
import { VERSION } from './config.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const node = new Node({
  ...(arg('port') ? { port: Number(arg('port')) } : {}),
  ...(arg('home') ? { home: arg('home') } : {}),
  ...(arg('ui') ? { uiDir: arg('ui') } : {}),
});

try {
  await node.start();
} catch (e: any) {
  if (e?.code === 'EADDRINUSE') {
    console.error(`[axo-node] port ${node.cfg.port} is in use — is another node running?`);
    process.exit(3);
  }
  throw e;
}
console.log(`[axo-node] v${VERSION} listening on http://${node.cfg.host}:${node.cfg.port} (home ${node.cfg.home})`);
if (node.cfg.uiDir) console.log(`[axo-node] UI: http://${node.cfg.host}:${node.cfg.port}/#token=${node.cfg.token}`);

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[axo-node] ${sig}: stopping agents…`);
  await node.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (e) => console.error('[axo-node] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[axo-node] unhandled', e));
