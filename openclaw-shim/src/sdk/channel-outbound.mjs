export function createAccountStatusSink(params) {
  return (status) => params?.setStatus?.(status);
}

export function createMessageReceiptFromOutboundResults() {
  return {};
}

export function createReplyToFanout() {
  return {};
}

export function createRuntimeOutboundDelegates() {
  return {};
}

export function defineChannelMessageAdapter(def) {
  return def;
}
