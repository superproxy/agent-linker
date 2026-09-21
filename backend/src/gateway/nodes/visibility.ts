import { LOCAL_NODE_ID } from '@linkagent/shared';

/** 管理员看全部（含本机）；其他人只看自己颁发 token 接入的远程机器 */
export function canSeeNode(
  node: { nodeId: string; ownerUsername?: string },
  opts: { admin: boolean; username?: string },
): boolean {
  if (opts.admin) return true;
  if (node.nodeId === LOCAL_NODE_ID) return false;
  return !!opts.username && node.ownerUsername === opts.username;
}
