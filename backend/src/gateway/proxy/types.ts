import { z } from 'zod';

/** 反向代理规则 */
export const ProxyRuleSchema = z.object({
  /** 规则ID，唯一标识 */
  id: z.string().uuid(),
  /** 匹配路径前缀 */
  pathPrefix: z.string().min(1),
  /** 目标上游地址 */
  upstream: z.string().min(1),
  /** 是否重写路径：移除匹配的pathPrefix前缀 */
  rewritePrefix: z.boolean().default(true),
  /** 是否启用该规则 */
  enabled: z.boolean().default(true),
  /** 权重，用于多个规则匹配时的优先级，数字越大优先级越高 */
  priority: z.number().int().default(0),
  /** 备注 */
  remark: z.string().default(''),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ProxyRule = z.infer<typeof ProxyRuleSchema>;

/** 反向代理配置 */
export const ProxyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  rules: z.array(ProxyRuleSchema).default([]),
});
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
