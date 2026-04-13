const sendBtn = document.getElementById('send');
const statusEl = document.getElementById('status');
const portInput = document.getElementById('port');

// Persist port
chrome.storage?.local?.get('port', (data) => {
  if (data.port) portInput.value = data.port;
});
portInput.addEventListener('change', () => {
  chrome.storage?.local?.set({ port: portInput.value });
});

sendBtn.addEventListener('click', async () => {
  sendBtn.disabled = true;
  statusEl.textContent = 'Sending…';
  statusEl.className = 'status';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) throw new Error('No active tab URL');

    const port = portInput.value || '9638';
    const res = await fetch(`http://127.0.0.1:${port}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: tab.url }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    statusEl.textContent = 'Sent! Check AudioSnatch.';
    statusEl.className = 'status ok';
  } catch (err) {
    statusEl.textContent = err.message.includes('Failed to fetch')
      ? 'AudioSnatch is not running or extension server is off.'
      : err.message;
    statusEl.className = 'status err';
  }

  sendBtn.disabled = false;
});
