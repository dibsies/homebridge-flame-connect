export class FlameConnectCloudError extends Error {
  constructor(message, { cause, kind = 'communication', code, resultCode, retryAfterMs } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FlameConnectCloudError';
    this.code = code || 'FLAMECONNECT_CLOUD_ERROR';
    this.kind = kind;
    if (resultCode !== undefined) this.resultCode = resultCode;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export function isTimeoutError(error) {
  return error?.name === 'TimeoutError'
    || error?.name === 'AbortError'
    || error?.code === 'ETIMEDOUT'
    || error?.cause?.code === 'ETIMEDOUT'
    || error?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';
}

export function isCloudError(error) {
  return error?.code === 'FLAMECONNECT_CLOUD_ERROR'
    || error?.code === 'FLAMECONNECT_REAUTH_REQUIRED'
    || error?.code === 'FLAMECONNECT_WRITE_AUTH_REFRESHED';
}

export function asCloudError(error, message) {
  if (isCloudError(error) || error?.code === 'FLAMECONNECT_NO_TOKEN') return error;
  return new FlameConnectCloudError(
    message || error?.message || 'Flame Connect cloud request failed.',
    { cause: error, kind: isTimeoutError(error) ? 'timeout' : 'communication' },
  );
}
