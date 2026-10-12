/**
 * openclaw/plugin-sdk/temp-path shim
 *
 * 微信/飞书插件在模块顶层 path.join(resolvePreferredOpenClawTmpDir(), ...)
 * 拼媒体临时目录，该函数必须返回字符串路径。
 * 语义与 infra-runtime 保持一致：OPENCLAW_TMP_DIR env → 系统临时目录。
 */
export { resolvePreferredOpenClawTmpDir } from '../infra-runtime.mjs';

export function withTempDownloadPath(...args) {
  const head = args[0];
  if (head && typeof head === 'object' && !Array.isArray(head)) return { ...head };
  return undefined;
}

export function withTempWorkspace(...args) {
  const head = args[0];
  if (head && typeof head === 'object' && !Array.isArray(head)) return { ...head };
  return undefined;
}
