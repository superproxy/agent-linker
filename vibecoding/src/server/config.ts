import { z } from 'zod';

export const configSchema = z.object({
  server: z.object({
    port: z.number().int().positive().default(9999),
    host: z.string().default('0.0.0.0'),
    enableHttp: z.boolean().default(true),
  }),
  // 服务端反向代理配置
  proxy: z.object({
    enabled: z.boolean().default(false),
    rules: z.array(
      z.object({
        match: z.string().min(1),
        target: z.string().min(1),
        rewrite: z.boolean().default(true),
        websocket: z.boolean().default(false),
      })
    ).default([]),
  }),
  // 服务端本地文件管理配置
  fileManager: z.object({
    enabled: z.boolean().default(true),
    rootPath: z.string().default('./'),
    allowWrite: z.boolean().default(true),
    allowDelete: z.boolean().default(true),
  }),
  auth: z.object({
    token: z.string().default(''),
  }),
});

export type ServerConfig = z.infer<typeof configSchema>;

export function loadConfig(): ServerConfig {
  const env = process.env;
  return configSchema.parse({
    server: {
      port: env.VIBECODING_PORT ? parseInt(env.VIBECODING_PORT) : undefined,
      host: env.VIBECODING_HOST,
      enableHttp: env.VIBECODING_ENABLE_HTTP !== 'false',
    },
    proxy: {
      enabled: env.VIBECODING_PROXY_ENABLED === 'true',
    },
    fileManager: {
      enabled: env.VIBECODING_FILEMANAGER_ENABLED !== 'false',
      rootPath: env.VIBECODING_FILEMANAGER_ROOT,
      allowWrite: env.VIBECODING_FILEMANAGER_ALLOW_WRITE !== 'false',
      allowDelete: env.VIBECODING_FILEMANAGER_ALLOW_DELETE !== 'false',
    },
    auth: {
      token: env.VIBECODING_AUTH_TOKEN,
    },
  });
}
