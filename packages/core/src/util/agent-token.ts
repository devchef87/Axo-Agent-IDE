import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-agent API token: `axa.<agentId>.<hmac>`. Handed to each claude process as AXO_TOKEN so
 * the node can tell which agent is calling (InnerChat sender, knock, watches) without trusting
 * a self-reported id. Derived from the node token, so nothing extra is stored.
 */
export function agentToken(nodeToken: string, agentId: string): string {
  return `axa.${agentId}.${sign(nodeToken, agentId)}`;
}

/** The agent id if `token` is a valid agent token for this node, else null. */
export function verifyAgentToken(nodeToken: string, token: string): string | null {
  const m = /^axa\.([a-z0-9]{1,64})\.([\w-]{32})$/.exec(token);
  if (!m) return null;
  const want = Buffer.from(sign(nodeToken, m[1]));
  const got = Buffer.from(m[2]);
  return got.length === want.length && timingSafeEqual(got, want) ? m[1] : null;
}

function sign(nodeToken: string, agentId: string): string {
  return createHmac('sha256', nodeToken).update(`agent:${agentId}`).digest('base64url').slice(0, 32);
}
