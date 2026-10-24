const MAX_DOWNLOAD_URL_LENGTH = 8192;

export function normalizeHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_DOWNLOAD_URL_LENGTH) {
    throw new Error('Enter a valid HTTP or HTTPS download link.');
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS download link.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP and HTTPS links without embedded credentials are allowed.');
  }

  return url.href;
}

export function createDownloadProtocolUrl(value: unknown): string {
  return `wasel://download?url=${encodeURIComponent(normalizeHttpUrl(value))}`;
}

export function parseDownloadProtocolUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_DOWNLOAD_URL_LENGTH * 2) {
    throw new Error('The Wasel link is invalid.');
  }

  let protocolUrl: URL;
  try {
    protocolUrl = new URL(value);
  } catch {
    throw new Error('The Wasel link is invalid.');
  }

  if (protocolUrl.protocol !== 'wasel:' || protocolUrl.hostname !== 'download' || !['', '/'].includes(protocolUrl.pathname)) {
    throw new Error('The Wasel link is invalid.');
  }

  const values = protocolUrl.searchParams.getAll('url');
  if (values.length !== 1) throw new Error('The Wasel link must contain exactly one download URL.');
  return normalizeHttpUrl(values[0]);
}
