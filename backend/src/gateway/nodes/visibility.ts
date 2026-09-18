import { LOCAL_NODE_ID } from '@linkagent/shared';

/** 管理员看全部；其他人看本机 + 自己颁发 token 接入的机器 */
export function canSeeNode(
  node: { nodeId: string; ownerUsername?: string },
  opts: { admin: boolean; username?: string },
): boolean {
  if (opts.admin) return true;
  if (node.nodeId === LOCAL_NODE_ID) return true;
  return !!opts.username && node.ownerUsername === opts.username;
}
