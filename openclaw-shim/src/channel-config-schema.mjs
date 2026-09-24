/**
 * openclaw/plugin-sdk/channel-config-schema shim
 *
 * buildChannelConfigSchema(schema)：把插件声明的 channel 配置 schema
 * （zod object / plain object）包装成 { schema } 结构。仅用于注册期
 * 描述性配置（无人深度消费），做轻量转换即可。
 */
function chainableSchema() {
  const schema = {
    optional() {
      return schema;
    },
    default() {
      return schema;
    },
    describe() {
      return schema;
    },
  };
  return schema;
}

export const ContextVisibilityModeSchema = chainableSchema();
export const DmPolicySchema = chainableSchema();
export const GroupPolicySchema = chainableSchema();
export const ReplyToModeSchema = chainableSchema();

export function buildGroupEntrySchema() {
  return chainableSchema();
}

export function buildMultiAccountChannelSchema() {
  return chainableSchema();
}

export function buildChannelConfigSchema(schema) {
  if (schema && typeof schema === 'object' && schema.shape && typeof schema.shape === 'object') {
    // zod object：提取字段为 JSON-schema 风格描述
    const properties = {};
    for (const [key, field] of Object.entries(schema.shape)) {
      const isOptional = typeof field?.isOptional === 'function' && field.isOptional();
      properties[key] = { type: 'unknown', required: !isOptional };
    }
    return { schema: { type: 'object', additionalProperties: false, properties, required: [] } };
  }
  return { schema: schema ?? {} };
}

export default { buildChannelConfigSchema };
