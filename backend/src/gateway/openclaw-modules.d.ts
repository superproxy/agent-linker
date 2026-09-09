/**
 * ambient 声明：无类型源的 openclaw 插件运行时子路径 / 无 types 的 npm 包。
 * - openclaw（workspace shim）为 .mjs，gateway 仅直接 import config-runtime 一个子路径
 * - @tencent-weixin/openclaw-weixin 无 .d.ts（runtime 插件包）
 * - qrcode-terminal 无 @types
 */

declare module 'openclaw/plugin-sdk/config-runtime' {
  export function setConfigRuntimeHostWrite(fn: (next: Record<string, unknown>) => void | Promise<void>): void;
}

declare module '@tencent-weixin/openclaw-weixin/dist/index.js';

declare module 'qrcode-terminal';
