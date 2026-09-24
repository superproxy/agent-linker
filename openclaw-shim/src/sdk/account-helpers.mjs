export function describeAccountSnapshot(params) {
  return {
    ...(params?.account ?? {}),
    configured: params?.configured,
    ...(params?.extra ?? {}),
  };
}
