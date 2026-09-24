export class PlatformMessageNotDispatchedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PlatformMessageNotDispatchedError';
  }
}
