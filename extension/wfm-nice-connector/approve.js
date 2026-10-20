const q = new URLSearchParams(location.search), req = q.get('r');
document.getElementById('o').textContent = q.get('o') || '(unknown)';
function send(allow) { chrome.runtime.sendMessage({ type: 'approve-result', req, allow }); setTimeout(() => window.close(), 150); }
document.getElementById('yes').addEventListener('click', () => send(true));
document.getElementById('no').addEventListener('click', () => send(false));
