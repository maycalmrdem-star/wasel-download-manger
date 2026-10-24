import { createDownloadProtocolUrl } from './link-protocol.js';
import { shouldCaptureDownload } from './download-capture.js';

const api = globalThis.browser || globalThis.chrome;

async function redirectBrowserDownload(download) {
  const settings = await api.storage.local.get({ captureBrowserDownloads: true });
  if (!shouldCaptureDownload(download, settings.captureBrowserDownloads)) return;

  const handoffUrl = createDownloadProtocolUrl(download.url);
  await api.tabs.create({ url: handoffUrl, active: false });
  await api.downloads.cancel(download.id);
}

api.downloads.onCreated.addListener((download) => {
  redirectBrowserDownload(download).catch((error) => {
    console.error('Wasel could not capture this browser download.', error);
  });
});
