import { createDownloadProtocolUrl } from './link-protocol.js';

const api = globalThis.browser || globalThis.chrome;
const input = document.getElementById('downloadUrl');
const message = document.getElementById('message');
const sendButton = document.getElementById('send');
const captureDownloads = document.getElementById('captureDownloads');
const captureStatus = document.getElementById('captureStatus');

function showError(error) {
  message.textContent = error.message || 'Could not prepare the download link.';
  message.classList.add('error');
}

api.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (tab?.url && /^https?:\/\//i.test(tab.url)) input.value = tab.url;
  else message.textContent = 'This page cannot be sent as a download link.';
}).catch(showError);

api.storage.local.get({ captureBrowserDownloads: true }).then((settings) => {
  captureDownloads.checked = settings.captureBrowserDownloads;
}).catch(showError);

captureDownloads.addEventListener('change', async () => {
  const enabled = captureDownloads.checked;
  captureDownloads.disabled = true;
  try {
    await api.storage.local.set({ captureBrowserDownloads: enabled });
    captureStatus.textContent = enabled
      ? 'Automatic browser download capture is enabled.'
      : 'Browser downloads will stay in the browser.';
  } catch (error) {
    captureDownloads.checked = !enabled;
    showError(error);
  } finally {
    captureDownloads.disabled = false;
  }
});

sendButton.addEventListener('click', () => {
  message.classList.remove('error');
  try {
    const protocolUrl = createDownloadProtocolUrl(input.value);
    window.location.assign(protocolUrl);
  } catch (error) {
    showError(error);
  }
});
