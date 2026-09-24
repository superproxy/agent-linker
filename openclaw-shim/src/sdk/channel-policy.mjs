export function createAllowlistProviderGroupPolicyWarningCollector() {
  return () => [];
}

export const createConditionalWarningCollector = {
  findings() {
    return () => [];
  },
};
