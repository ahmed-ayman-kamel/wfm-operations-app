document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;
async function draw() {
  const ul = document.getElementById('list'); ul.textContent = '';
  const st = await chrome.storage.local.get('approved'), a = st.approved || {}, keys = Object.keys(a);
  if (!keys.length) { const li = document.createElement('li'); li.textContent = 'None yet. The first Start automation asks you.'; ul.appendChild(li); return; }
  keys.forEach(o => {
    const li = document.createElement('li'), s = document.createElement('span'), b = document.createElement('button');
    s.textContent = o; b.textContent = 'Remove';
    b.addEventListener('click', async () => { delete a[o]; await chrome.storage.local.set({ approved: a }); draw(); });
    li.append(s, b); ul.appendChild(li);
  });
}
draw();

async function drawHistory() {
  const ul = document.getElementById('hist'); ul.textContent = '';
  const h = ((await chrome.storage.local.get('history')).history || []).slice(-8).reverse();
  if (!h.length) { const li = document.createElement('li'); li.textContent = 'No runs yet.'; ul.appendChild(li); return; }
  h.forEach(r => {
    const li = document.createElement('li'), a = document.createElement('span'), b = document.createElement('span');
    a.textContent = new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' · ' + r.report + ' · ' + r.seconds + ' s';
    a.className = 't'; a.title = r.message || '';
    b.textContent = r.status; b.className = r.status === 'OK' ? 'ok' : 'bad'; if (r.message) b.title = r.message;
    li.append(a, b); ul.appendChild(li);
  });
}
drawHistory();
