export function shouldCaptureDownload(download, enabled = true) {
  if (!enabled || !download || download.state !== 'in_progress' || download.incognito || download.byExtensionId) {
    return false;
  }

  try {
    const url = new URL(download.url);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
