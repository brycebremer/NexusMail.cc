var S = {
  connected: false, folder: null, folders: [],
  messages: [], selected: new Set(),
  activeUid: null, activeMsg: null,
  ws: null, allSelected: false, showHtml: false,
  notifiedUids: new Set(),
  newUids: new Set,
  initialized: false,
  threadView: false,
  threads: [],
  msgPage: 1, msgTotal: 0, msgLoading: false,
  plainTextMode: false,
  draftUid: null, // UID of draft being edited (null = new compose)
  draftAutoSave: null // auto-save timer
};

function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function formatSize(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}
function fileIcon(name) {
  var ext = (name || '').split('.').pop().toLowerCase();
  var map = {pdf:'PDF',doc:'DOC',docx:'DOC',xls:'XLS',xlsx:'XLS',ppt:'PPT',pptx:'PPT',zip:'ZIP',rar:'ZIP','7z':'ZIP',tar:'ZIP',gz:'ZIP',jpg:'IMG',jpeg:'IMG',png:'IMG',gif:'IMG',svg:'IMG',webp:'IMG',mp3:'AUD',wav:'AUD',mp4:'VID',avi:'VID',mov:'VID',txt:'TXT',csv:'CSV',json:'JSON',html:'HTML'};
  return map[ext] || 'ATT'
  return map[ext] || '📎';
}
window._composeFiles = [];
function handleComposeFiles(files) {
  for (var i = 0; i < files.length; i++) {
    window._composeFiles.push(files[i]);
  }
  renderComposeFiles();
  document.getElementById('composeFileInput').value = '';
}
function removeComposeFile(index) {
  window._composeFiles.splice(index, 1);
  renderComposeFiles();
}
function renderComposeFiles() {
  var bar = document.getElementById('composeAttBar');
  var list = document.getElementById('composeFileList');
  if (!window._composeFiles.length) { bar.style.display = 'none'; list.innerHTML = ''; return; }
  bar.style.display = 'flex';
  var html = '';
  for (var i = 0; i < window._composeFiles.length; i++) {
    var f = window._composeFiles[i];
    html += '<span class="compose-att-item">' + fileIcon(f.name) + ' ' + esc(f.name) + ' <span style="color:var(--text2)">(' + formatSize(f.size) + ')</span><span class="att-rm" onclick="removeComposeFile(' + i + ')">×</span></span>';
  }
  list.innerHTML = html;
}
function fmtDate(d) {
  var dt = new Date(d), now = new Date();
  if (dt.toDateString() === now.toDateString()) return dt.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
  if (dt.getFullYear() === now.getFullYear()) return dt.toLocaleDateString([], {month:'short',day:'numeric'});
  return dt.toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'});
}

function toast(msg, type) {
  var t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  document.getElementById('toasts').appendChild(t);
  requestAnimationFrame(function() { t.classList.add('show'); });
  setTimeout(function() { t.classList.remove('show'); setTimeout(function() { t.remove(); }, 300); }, 2800);
}

function api(path, opts) {
  return fetch('/api/' + path, Object.assign({ credentials: 'include' }, opts || {})).then(function(r) {
    if (r.status === 401) { showLogin(); throw new Error('Auth required'); }
    return r.json();
  }).then(function(j) {
    if (j.error) { toast(j.error, 'error'); throw new Error(j.error); }
    return j;
  });
}

function svg(d, sz) {
  return '<svg width="'+(sz||14)+'" height="'+(sz||14)+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.55">'+d+'</svg>';
}

function folderIcon(f) {
  var icons = {
    '\\Inbox': svg('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
    '\\Sent': svg('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
    '\\Drafts': svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
    '\\Trash': svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    '\\Junk': svg('<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'),
    '\\Archive': svg('<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>')
  };
  if (f.specialUse && icons[f.specialUse]) return icons[f.specialUse];
  if (f.name === 'INBOX') return icons['\\Inbox'];
  if (f.name === 'Favorites') return svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>', 14);
  return svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>');
}

// ── Desktop Notifications ──
function requestNotifPermission() {
  if (!('Notification' in window)) {
    console.log('[Notify] Browser does not support Notification API');
    return;
  }
  console.log('[Notify] Current permission:', Notification.permission);
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(function(perm) {
      console.log('[Notify] Permission result:', perm);
      toast(perm === 'granted' ? 'Desktop notifications enabled' : 'Notifications blocked — check browser settings', perm === 'granted' ? 'success' : 'error');
    });
  } else if (Notification.permission === 'denied') {
    toast('Notifications are blocked — enable them in browser settings', 'error');
  }
}

function pushDesktopNotification(title, body, tag) {
  if (!('Notification' in window)) {
    console.log('[Notify] No Notification API');
    return;
  }
  if (Notification.permission === 'denied') return;
  if (Notification.permission === 'default') {
    // Try asking one more time
    Notification.requestPermission().then(function(perm) {
      if (perm === 'granted') pushDesktopNotification(title, body, tag);
    });
    return;
  }
  try {
    console.log('[Notify] Pushing notification:', title);
    var n = new Notification(title, {
      body: body,
      tag: tag || undefined,
      icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#a8324a"/><text x="50" y="66" font-size="50" fill="white" text-anchor="middle" font-family="sans-serif" font-weight="bold">NM</text></svg>')
    });
    n.onclick = function() { window.focus(); n.close(); };
    setTimeout(function() { n.close(); }, 8000);
  } catch(e) {
    console.error('[Notify] Error:', e);
  }
}

// Fetch message body preview for notification
function fetchPreview(folderPath, uid) {
  return api('peek?folder=' + encodeURIComponent(folderPath) + '&uid=' + uid).then(function(m) {
    var text = (m.textBody || m.htmlBody || '').replace(/<[^>]*>/g, '').replace(/\r?\n/g, ' ').trim();
    var preview = text.length > 120 ? text.substring(0, 117) + '...' : text;
    return { to: m.to || '', preview: preview };
  }).catch(function() { return { to: '', preview: '' }; });
}

// When new mail arrives, fetch the latest messages and notify
function notifyNewMail(folderPath) {
  console.log('[Notify] notifyNewMail called for', folderPath, 'initialized:', S.initialized);
  api('messages?folder=' + encodeURIComponent(folderPath) + '&limit=5').then(function(r) {
    var msgs = r.messages || [];
    var newMsgs = [];
    console.log('[Notify] Fetched', msgs.length, 'messages, looking for unread ones');

    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      // m.read === true means READ (has \Seen flag)
      if (!m.read && !S.notifiedUids.has(m.id)) {
        S.notifiedUids.add(m.id);
        newMsgs.push(m);
      }
    }

    console.log('[Notify] Found', newMsgs.length, 'new messages, initialized:', S.initialized);

    // On first run, just seed UIDs — don't notify or highlight existing mail
    if (!S.initialized) {
      S.initialized = true;
      return;
    }

    // Only highlight and notify for genuinely new messages
    if (newMsgs.length > 0) console.log('[Notify] Found', newMsgs.length, 'new messages in', folderPath);
    for (var i = 0; i < newMsgs.length; i++) {
      var m = newMsgs[i];
      S.newUids.add(m.id);

      if (i < 3) {
        // Fetch body preview, then push notification
        (function(msg) {
          fetchPreview(folderPath, msg.id).then(function(result) {
            var body = 'To: ' + result.to;
            if (result.preview) body += '\n' + result.preview;
            pushDesktopNotification(
              msg.from.split('<')[0].trim() + ' \u2014 ' + msg.subject,
              body,
              'mail-' + msg.id
            );
          });
        })(m);
      }
    }

    // Re-render messages if we're looking at this folder (to show highlight)
    if (newMsgs.length > 0 && S.folder === folderPath) {
      var existingIds = new Set(S.messages.map(function(x) { return x.id; }));
      for (var i = newMsgs.length - 1; i >= 0; i--) {
        if (!existingIds.has(newMsgs[i].id)) {
          S.messages.unshift(newMsgs[i]);
        }
      }
      renderMessages();
      setTimeout(function() {
        S.newUids.clear();
        renderMessages();
      }, 6000);
    }

    // Trim notifiedUids to prevent unbounded growth
    if (S.notifiedUids.size > 200) {
      var arr = Array.from(S.notifiedUids);
      S.notifiedUids = new Set(arr.slice(arr.length - 200));
    }
  }).catch(function() {});
}

function showLogin() { var el = document.getElementById('loginOverlay'); if (el) el.classList.add('show'); }
function hideLogin() { var el = document.getElementById('loginOverlay'); if (el) el.classList.remove('show'); }

function doLogin() {
  var u = document.getElementById('lUser').value;
  var p = document.getElementById('lPass').value;
  var remember = document.getElementById('lRemember').checked;
  if (!u || !p) { toast('Enter username and password', 'error'); return; }
  toast('Signing in...');
  api('login', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ username: u, password: p, remember: remember })
  }).then(function(r) {
    hideLogin(); toast('Connected to ' + r.user, 'success'); connectWS();
    requestNotifPermission();
  }).catch(function(e) { toast('Login failed: ' + e.message, 'error'); });
}

function doLogout() {
  api('logout', { method: 'POST' }).then(function() { showLogin(); toast('Logged out'); }).catch(function() {});
}

function connectWS() {
  if (S.ws && S.ws.readyState < 2) return;
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  S.ws = new WebSocket(proto + '://' + location.host + '/ws');
  S.ws.onmessage = function(e) {
    var data = JSON.parse(e.data);
    if (data.type === 'imap:connected') { setConnected(true, data.data); }
    if (data.type === 'imap:disconnected') { setConnected(false); }
    if (data.type === 'imap:newMail') {
      console.log('[Notify] Received imap:newMail event:', JSON.stringify(data.data));
      var paths = data.data.paths || [data.data.path];
      var currentChanged = false;
      for (var i = 0; i < paths.length; i++) {
        if (S.folder === paths[i]) currentChanged = true;
        notifyNewMail(paths[i]);
      }
      if (currentChanged) loadMessages();
      loadFolders();
    }
    if (data.type === 'imap:flagsChanged') { if (S.folder === data.data.path) loadMessages(); loadFolders(); }
    if (data.type === 'imap:error') { toast(data.data, 'error'); }
    if (data.type === 'status') { setConnected(data.data.connected, data.data); }
  };
  S.ws.onclose = function() { S.ws = null; setTimeout(connectWS, 3000); };
  S.ws.onerror = function() { S.ws = null; };
}

function setConnected(v, info) {
  S.connected = v;
  document.getElementById('connDot').className = v ? 'dot dot-on' : 'dot dot-off dot-pulse';
  document.getElementById('connText').textContent = v ? (info.user + ' @ ' + info.host) : 'Not connected';
  if (v) loadFolders();
}

function loadFolders() {
  api('folders').then(function(folders) {
    S.folders = folders; renderFolders();
    if (!S.folder && folders.length) selectFolder(folders[0].path);
  }).catch(function(e) { toast('Folder error: ' + e.message, 'error'); });
}

function isSpecialFolder(f) {
  if (f.specialUse) return true;
  var lower = f.path.toLowerCase();
  return (lower === 'inbox' || lower === 'trash' || lower === 'sent' || lower === 'drafts' || lower === 'junk' || lower === 'spam' || lower === 'favorites');
}

function renderFolders() {
  var html = '';
  var hadSpecial = false;
  for (var i = 0; i < S.folders.length; i++) {
    var f = S.folders[i];
    var isSpecial = isSpecialFolder(f);
    // Insert spacer between special and user folders
    if (hadSpecial && !isSpecial) {
      html += '<div class="folder-spacer"></div>';
      hadSpecial = false;
    }
    if (isSpecial) hadSpecial = true;
    html += '<div class="folder ' + (S.folder===f.path?'active':'') + '" data-folder="' + esc(f.path) + '">';
    html += '<span class="f-icon">' + folderIcon(f) + '</span>';
    var displayName = f.unread ? esc(f.name) + ' <span class="f-unread-count">(' + f.unread + ')</span>' : esc(f.name);
    html += '<span class="f-name">' + displayName + '</span>';
    if (f.total) html += '<span class="f-badge">' + f.total + '</span>';
    html += '</div>';
  }
  document.getElementById('folders').innerHTML = html;
  var items = document.querySelectorAll('#folders .folder');
  for (var i = 0; i < items.length; i++) {
    items[i].addEventListener('click', function() { selectFolder(this.getAttribute('data-folder')); });
    items[i].addEventListener('contextmenu', function(e) {
      e.preventDefault();
      folderContextMenu(e, this.getAttribute('data-folder'));
    });
    // Drag and drop: allow dropping messages on folders
    items[i].addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.classList.add('drop-target');
    });
    items[i].addEventListener('dragleave', function(e) {
      // Only remove highlight if actually leaving the folder element
      if (!this.contains(e.relatedTarget)) {
        this.classList.remove('drop-target');
      }
    });
    items[i].addEventListener('drop', function(e) {
      e.preventDefault();
      this.classList.remove('drop-target');
      try {
        var data = JSON.parse(e.dataTransfer.getData('text/plain'));
        var dest = this.getAttribute('data-folder');
        if (!data.uids || !data.uids.length) return;
        // Don't drop on same folder
        if (data.folder === dest) { toast('Already in this folder', 'error'); return; }
        if (data.uids.length === 1) {
          toast('Moving message to ' + dest + '…');
        } else {
          toast('Moving ' + data.uids.length + ' messages to ' + dest + '…');
        }
        api('move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: data.folder, dest: dest, uids: data.uids })
        }).then(function(r) {
          toast('Moved to ' + dest, 'success');
          S.selected.clear();
          loadFolders(); loadMessages();
        }).catch(function(e) { toast(e.message, 'error'); });
      } catch(ex) { /* not our drag data */ }
    });
  }
}

function folderContextMenu(e, path) {
  closeFolderMenu();
  var lower = path.toLowerCase();
  var isSpecial = (lower === 'inbox' || lower === 'trash' || lower === 'sent' || lower === 'drafts' || lower === 'junk' || lower === 'spam');
  var menu = document.createElement('div');
  menu.className = 'folder-menu';
  menu.id = 'folderContextMenu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.innerHTML = '<div class="folder-menu-item" data-action="move">Move messages here…</div>' +
    (isSpecial ? '' : '<div class="folder-menu-item" data-action="rename">Rename folder</div>') +
    (isSpecial ? '' : '<div class="folder-menu-item danger" data-action="delete">Delete folder</div>');
  document.body.appendChild(menu);
  // Adjust position if off-screen
  var rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
  S._menuFolder = path;
  var menuItems = menu.querySelectorAll('.folder-menu-item');
  for (var i = 0; i < menuItems.length; i++) {
    menuItems[i].addEventListener('click', function() {
      var action = this.getAttribute('data-action');
      if (action === 'rename') {
        var newName = prompt('Rename folder:', path);
        if (newName && newName.trim() && newName.trim() !== path) {
          api('folders/rename', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ oldPath: path, newPath: newName.trim() }) }).then(function() {
            toast('Folder renamed', 'success'); loadFolders();
          }).catch(function(e) { toast(e.message, 'error'); });
        }
      } else if (action === 'delete') {
        deleteFolder(path);
      } else if (action === 'move') {
        // Move selected messages to this folder
        if (S.selected.size > 0) {
          S._moveUids = Array.from(S.selected);
          doMoveTo(path);
        } else if (S.activeUid) {
          S._moveUids = [S.activeUid];
          doMoveTo(path);
        } else {
          toast('Select messages first', 'error');
        }
      }
      closeFolderMenu();
    });
  }
  // Close on click outside
  setTimeout(function() {
    document.addEventListener('click', closeFolderMenu, { once: true });
  }, 10);
}

function closeFolderMenu() {
  var el = document.getElementById('folderContextMenu');
  if (el) el.remove();
}

// ── Thread View ──
function toggleThreadView() {
  S.threadView = !S.threadView;
  var btn = document.getElementById('threadToggle');
  if (btn) btn.classList.toggle('active', S.threadView);
  loadMessages();
}

function toggleThread(tid, row) {
  var existing = document.getElementById('thread-' + tid);
  if (existing) { existing.remove(); row.classList.remove('thread-open'); return; }
  // Find the thread
  var thread = null;
  for (var i = 0; i < S.threads.length; i++) {
    if (String(S.threads[i].id) === tid) { thread = S.threads[i]; break; }
  }
  if (!thread || thread.messages.length <= 1) return;
  row.classList.add('thread-open');
  var div = document.createElement('div');
  div.id = 'thread-' + tid;
  div.className = 'thread-expanded';
  for (var i = 0; i < thread.messages.length; i++) {
    var m = thread.messages[i];
    var cls = 'thread-item' + (m.id === S.activeUid ? ' active' : '') + (!m.read ? ' unread' : '');
    div.innerHTML += '<div class="' + cls + '" data-uid="' + m.id + '">' +
      '<span class="ti-from">' + esc(m.from.split('<')[0].trim()) + '</span>' +
      '<span class="ti-subj">' + esc(m.subject) + '</span>' +
      '<span class="ti-date">' + fmtDate(m.date) + '</span>' +
      '</div>';
  }
  row.parentNode.insertBefore(div, row.nextSibling);
  // Wire click on thread items
  div.querySelectorAll('.thread-item').forEach(function(el) {
    el.addEventListener('click', function() { openMsg(parseInt(this.getAttribute('data-uid'))); });
  });
}

function selectFolder(path) {
  S.folder = path; S.selected.clear(); S.activeUid = null; S.activeMsg = null; S.allSelected = false;
  renderFolders(); loadMessages();
  document.getElementById('msgView').innerHTML = '<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" style="opacity:.3"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg><p>Select a message</p></div>';
}

function loadMessages() {
  S.msgPage = 1;
  var el = document.getElementById('msgScroll');
  el.innerHTML = '<div class="loading"><div class="spinner"></div> Loading\u2026</div>';
  var endpoint = S.threadView
    ? 'threads?folder=' + encodeURIComponent(S.folder) + '&limit=80&page=1'
    : 'messages?folder=' + encodeURIComponent(S.folder) + '&limit=80&page=1';
  api(endpoint).then(function(r) {
    if (S.threadView) {
      S.threads = r.threads || [];
      S.messages = [];
      // Build flat list for compatibility (first msg of each thread)
      S.messages = S.threads.map(function(t) { return Object.assign({}, t.messages[0], { _thread: t }); });
      S.msgTotal = r.total || 0;
    } else {
      S.messages = r.messages || [];
      S.threads = [];
      S.msgTotal = r.total || 0;
    }
    document.getElementById('folderTitle').textContent = S.folder;
    document.getElementById('folderCount').textContent = S.msgTotal ? S.msgTotal + ' messages' : '';
    // Show/hide Empty Trash button
    var etb = document.getElementById('emptyTrashBtn');
    if (etb) etb.style.display = (S.folder === 'Trash') ? '' : 'none';
    renderMessages();
    // Seed notifiedUids with current message IDs on first load
    // so existing mail won't be treated as "new" when polling fires
    if (!S.initialized) {
      for (var i = 0; i < S.messages.length; i++) {
        S.notifiedUids.add(S.messages[i].id);
      }
      S.initialized = true;
      console.log('[Notify] Seeded', S.notifiedUids.size, 'existing UIDs, initialized = true');
    }
  }).catch(function(e) { el.innerHTML = '<div class="empty-state"><p>Error: ' + esc(e.message) + '</p></div>'; });
}

function loadMoreMessages() {
  if (S.msgLoading) return;
  if (S.messages.length >= S.msgTotal) return;
  S.msgLoading = true;
  S.msgPage++;
  api('messages?folder=' + encodeURIComponent(S.folder) + '&limit=80&page=' + S.msgPage).then(function(r) {
    var more = r.messages || [];
    for (var i = 0; i < more.length; i++) {
      var exists = false;
      for (var j = 0; j < S.messages.length; j++) { if (S.messages[j].id === more[i].id) { exists = true; break; } }
      if (!exists) S.messages.push(more[i]);
    }
    S.msgLoading = false;
    renderMessages();
  }).catch(function() { S.msgLoading = false; });
}

function renderMessages() {
  var msgs = S.messages;
  if (!msgs.length) { document.getElementById('msgScroll').innerHTML = '<div class="empty-state"><p>No messages</p></div>'; return; }
  var html = '';
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    var isNew = S.newUids.has(m.id);
    var isThread = S.threadView && m._thread && m._thread.messages.length > 1;
    var classes = 'msg-row';
    if (m.id === S.activeUid) classes += ' active';
    if (!m.read) classes += ' unread';
    if (isNew) classes += ' new-msg';
    if (S.selected.has(m.id)) classes += ' selected';
    if (isThread) classes += ' has-thread';
    html += '<div class="' + classes + '" data-uid="' + m.id + '" data-thread-id="' + (isThread ? m._thread.id : '') + '" draggable="true">';
    html += '<div class="m-sel" data-uid="' + m.id + '">' + (S.selected.has(m.id) ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--accent)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>') + '</div>';
    html += '<span class="m-from">' + esc(m.from.split('<')[0].trim()) + '</span>';
    html += '<span class="m-subj">' + esc(m.subject) + (isThread ? ' <span class="thread-count">(' + m._thread.messages.length + ')</span>' : '') + '</span>';
    if (isThread && m._thread.unread) html += '<span class="thread-unread">' + m._thread.unread + '</span>';
    html += '<div class="m-meta"><span class="m-date">' + fmtDate(m.date) + '</span>';
    var inFav = (S.folder === 'Favorites');
    html += '<div class="m-flags"><span class="star ' + (inFav?'on':'') + '" data-uid="' + m.id + '" data-starred="' + inFav + '" style="color:' + (inFav?'var(--warn)':'') + '">' + svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',12) + '</span>';
    if (m.hasAttachments) html += svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>', 12);
    html += '</div></div></div>';
  }
  // Add load more button if there are more messages
  if (S.messages.length < S.msgTotal) {
    html += '<div class="load-more" onclick="loadMoreMessages()">Load more (' + (S.msgTotal - S.messages.length) + ' remaining)</div>';
  }
  document.getElementById('msgScroll').innerHTML = html;
  var rows = document.querySelectorAll('.msg-row');
  for (var i = 0; i < rows.length; i++) {
    rows[i].addEventListener('click', function(e) {
      if (e.target.closest('.star') || e.target.closest('.m-sel') || e.target.closest('.thread-expand')) return;
      var uid = parseInt(this.getAttribute('data-uid'));
      var tid = this.getAttribute('data-thread-id');
      // If in thread view and this is a thread, toggle expand
      if (S.threadView && tid) { toggleThread(tid, this); return; }
      if (e.ctrlKey || e.metaKey) {
        toggleSel(uid);
      } else {
        openMsg(uid);
      }
    });
    rows[i].addEventListener('contextmenu', function(e) {
      e.preventDefault();
      msgContextMenu(e, parseInt(this.getAttribute('data-uid')));
    });
    // Drag start
    rows[i].addEventListener('dragstart', function(e) {
      var uid = this.getAttribute('data-uid');
      // If messages are selected, drag all selected. Otherwise drag just this one.
      var uids;
      if (S.selected.size > 0 && S.selected.has(parseInt(uid))) {
        uids = Array.from(S.selected);
      } else {
        uids = [parseInt(uid)];
      }
      e.dataTransfer.setData('text/plain', JSON.stringify({ folder: S.folder, uids: uids }));
      e.dataTransfer.effectAllowed = 'move';
      this.classList.add('dragging');
      // Create drag image showing count
      if (uids.length > 1) {
        var ghost = document.createElement('div');
        ghost.textContent = uids.length + ' messages';
        ghost.style.cssText = 'position:fixed;top:-100px;left:-100px;background:var(--surface);color:var(--text);padding:6px 12px;border-radius:6px;font-size:13px;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,.4)';
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        setTimeout(function() { ghost.remove(); }, 0);
      }
    });
    rows[i].addEventListener('dragend', function() {
      this.classList.remove('dragging');
      // Clean up any folder highlights
      var items = document.querySelectorAll('#folders .folder');
      for (var j = 0; j < items.length; j++) items[j].classList.remove('drop-target');
    });
  }
  var sels = document.querySelectorAll('.m-sel');
  for (var i = 0; i < sels.length; i++) {
    sels[i].addEventListener('click', function(e) {
      e.stopPropagation();
      toggleSel(parseInt(this.getAttribute('data-uid')));
    });
  }
  var stars = document.querySelectorAll('.star');
  for (var i = 0; i < stars.length; i++) {
    stars[i].addEventListener('click', function(e) {
      e.stopPropagation();
      var uid = parseInt(this.getAttribute('data-uid'));
      doStar(uid);
    });
  }
}

function openMsg(uid) {
  // If in Drafts folder, open draft in compose instead
  if (S.folder === 'Drafts') { openDraft(uid); return; }
  S.activeUid = uid;
  S.newUids.delete(uid);  // Clear new-message highlight when opened
  // Optimistically mark as read in local state
  for (var i = 0; i < S.messages.length; i++) {
    if (S.messages[i].id === uid) {
      if (!S.messages[i].read) { S.messages[i].read = true; renderMessages(); }
      break;
    }
  }
  var el = document.getElementById('msgView');
  el.innerHTML = '<div class="loading"><div class="spinner"></div> Loading\u2026</div>';
  api('message?folder=' + encodeURIComponent(S.folder) + '&uid=' + uid).then(function(m) {
    S.activeMsg = m;
    S.showHtml = false;

    var bodyContent;
    if (m.htmlBody) {
      S.showHtml = true;
      bodyContent = '<div class="ev-body" style="display:none">' + esc(m.textBody || 'No content') + '</div>' +
        '<iframe id="htmlFrame" sandbox="allow-same-origin" style="width:calc(100% - 44px);border:none;margin:0 22px;background:#fff;border-radius:4px"></iframe>';
    } else {
      bodyContent = '<div class="ev-body">' + esc(m.textBody || 'No content') + '</div>';
    }

    // Attachments
    var attachHtml = '';
    if (m.attachments && m.attachments.length) {
      attachHtml = '<div class="ev-attachments"><div class="ev-attachments-label">' + m.attachments.length + ' attachment' + (m.attachments.length > 1 ? 's' : '') + '</div>';
      for (var ai = 0; ai < m.attachments.length; ai++) {
        var att = m.attachments[ai];
        var icon = fileIcon(att.name || att.contentType);
        var size = formatSize(att.size);
        var dlUrl = '/api/attachment?folder=' + encodeURIComponent(S.folder) + '&uid=' + uid + '&index=' + ai;
        attachHtml += '<a class="ev-att" href="' + dlUrl + '" download="" target="_blank">' +
          '<span class="ev-att-icon">' + icon + '</span>' +
          '<span class="ev-att-info"><span class="ev-att-name">' + esc(att.name || 'attachment') + '</span><span class="ev-att-size">' + size + '</span></span>' +
          '<span class="ev-att-dl">' + svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', 14) + '</span></a>';
      }
      attachHtml += '</div>';
    }

    el.innerHTML = '<div class="ev-header"><h2>' + esc(m.subject) + '</h2>' +
      '<div class="ev-meta"><span class="label">From</span><span class="value">' + esc(m.from) + '</span>' +
      '<span class="label">To</span><span class="value">' + esc(m.to) + '</span>' +
      (m.cc ? '<span class="label">CC</span><span class="value">' + esc(m.cc) + '</span>' : '') +
      '<span class="label">Date</span><span class="value">' + new Date(m.date).toLocaleString() + '</span></div></div>' +
      '<div class="ev-actions"><button class="btn btn-sm" onclick="replyMsg()">' + svg('<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',14) + ' Reply</button>' +
      '<button class="btn btn-sm" onclick="forwardMsg()">' + svg('<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',14) + ' Forward</button>' +
      '<button class="btn btn-sm" onclick="moveMsg()">' + svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><polyline points="12 11 12 17"/><polyline points="9 14 12 11 15 14"/>',14) + ' Move</button>' +
      '<button class="btn btn-sm btn-danger" onclick="deleteMsg()">' + svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',14) + ' Delete</button>' +
      '<button class="btn btn-sm" id="toggleHtmlBtn" style="margin-left:auto;color:var(--text2);font-size:11px">View as Text</button></div>' +
      bodyContent + attachHtml;

    var toggleBtn = document.getElementById('toggleHtmlBtn');
    if (toggleBtn) toggleBtn.style.color = 'var(--text2)';
 var htmlFrame = document.getElementById('htmlFrame');
    if (toggleBtn && htmlFrame) {
      // Write HTML into iframe immediately (shown by default)
      var doc = htmlFrame.contentDocument || htmlFrame.contentWindow.document;
      doc.open(); doc.write('<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#222;margin:0;padding:8px 4px;word-break:break-word}a{color:#a8324a}blockquote{border-left:3px solid #ccc;margin:8px 0;padding:4px 12px;color:#666}img{max-width:100%;height:auto}pre{overflow-x:auto}</style></head><body>' + m.htmlBody + '</body></html>'); doc.close();
      setTimeout(function() {
        try { htmlFrame.style.height = (doc.body.scrollHeight + 20) + 'px'; } catch(e) {}
      }, 150);
      // Retry after images load
      setTimeout(function() {
        try { htmlFrame.style.height = (doc.body.scrollHeight + 20) + 'px'; } catch(e) {}
      }, 1000);
      toggleBtn.addEventListener('click', function() {
        if (!S.showHtml) {
          htmlFrame.style.display = 'block';
          try { htmlFrame.style.height = (doc.body.scrollHeight + 20) + 'px'; } catch(e) {}
          document.querySelector('.ev-body').style.display = 'none';
          toggleBtn.textContent = 'View as Text';
          toggleBtn.style.color = 'var(--text2)';
          S.showHtml = true;
        } else {
          htmlFrame.style.display = 'none';
          document.querySelector('.ev-body').style.display = '';
          toggleBtn.textContent = 'View as HTML';
          toggleBtn.style.color = 'var(--accent)';
          S.showHtml = false;
        }
      });
    }

    for (var i = 0; i < S.messages.length; i++) { if (S.messages[i].id === uid) { S.messages[i].read = true; break; } }
    renderMessages(); renderFolders();
  }).catch(function(e) { el.innerHTML = '<div class="empty-state"><p>Failed: ' + esc(e.message) + '</p></div>'; });
}

function toggleSel(uid) { S.selected.has(uid) ? S.selected.delete(uid) : S.selected.add(uid); renderMessages(); }
function toggleSelectAll() { if (S.allSelected) { S.selected.clear(); S.allSelected = false; } else { for (var i=0;i<S.messages.length;i++) S.selected.add(S.messages[i].id); S.allSelected = true; } renderMessages(); }

function doStar(uid) {
  // In Favorites: unstar = move back to INBOX. Elsewhere: star = move to Favorites.
  // Always mark as read in destination and track UID to prevent re-notification
  if (S.folder === 'Favorites') {
    api('move', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ folder: S.folder, dest: 'INBOX', uids: [uid] }) }).then(function() {
      // Mark as read in INBOX so it doesn't show as unread
      api('markread', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ folder: 'INBOX', uids: [uid] }) }).catch(function() {});
      // Track UID so polling doesn't treat it as a new message
      S.notifiedUids.add(uid);
      S.newUids.delete(uid);
      S.messages = S.messages.filter(function(m) { return m.id !== uid; });
      if (S.activeUid === uid) {
        S.activeUid = null; S.activeMsg = null;
        document.getElementById('msgView').innerHTML = '<div class="empty-state"><p>Removed from Favorites</p></div>';
      }
      renderMessages(); renderFolders(); toast('Removed from Favorites', 'success');
    }).catch(function(e) { toast(e.message, 'error'); });
  } else {
    api('folders/create', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name: 'Favorites' }) }).catch(function() {}).then(function() {
      return api('move', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ folder: S.folder, dest: 'Favorites', uids: [uid] }) });
    }).then(function() {
      // Mark as read in Favorites
      api('markread', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ folder: 'Favorites', uids: [uid] }) }).catch(function() {});
      // Track UID so polling doesn't re-notify
      S.notifiedUids.add(uid);
      S.newUids.delete(uid);
      S.messages = S.messages.filter(function(m) { return m.id !== uid; });
      if (S.activeUid === uid) {
        S.activeUid = null; S.activeMsg = null;
        document.getElementById('msgView').innerHTML = '<div class="empty-state"><p>Moved to Favorites</p></div>';
      }
      renderMessages(); renderFolders(); toast('Added to Favorites', 'success');
    }).catch(function(e) { toast(e.message, 'error'); });
  }
}

function deleteMsg() {
  if (!S.activeUid) return;
  api('delete', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({folder:S.folder, uids:[S.activeUid]}) }).then(function() {
    S.messages = S.messages.filter(function(m) { return m.id !== S.activeUid; });
    S.activeUid = null; S.activeMsg = null;
    document.getElementById('msgView').innerHTML = '<div class="empty-state"><p>Deleted</p></div>';
    renderMessages(); renderFolders(); toast('Deleted', 'success');
  }).catch(function(e) { toast(e.message, 'error'); });
}

function deleteSelected() {
  if (!S.selected.size) return;
  api('delete', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({folder:S.folder, uids:Array.from(S.selected)}) }).then(function() {
    S.messages = S.messages.filter(function(m) { return !S.selected.has(m.id); });
    S.selected.clear(); renderMessages(); renderFolders(); toast('Deleted', 'success');
  }).catch(function(e) { toast(e.message, 'error'); });
}

function markReadSelected() {
  if (!S.selected.size) return;
  var uids = Array.from(S.selected);
  api('markread', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({folder:S.folder, uids:uids}) }).then(function() {
    for (var i = 0; i < S.messages.length; i++) {
      if (S.selected.has(S.messages[i].id)) S.messages[i].read = true;
    }
    S.selected.clear(); renderMessages(); renderFolders(); toast('Marked as read', 'success');
  }).catch(function(e) { toast(e.message, 'error'); });
}

function emptyTrash() {
  if (!confirm('Permanently delete all messages in Trash? This cannot be undone.')) return;
  api('emptytrash', { method: 'POST' }).then(function(r) {
    S.messages = [];
    S.msgTotal = 0;
    document.getElementById('msgView').innerHTML = '<div class="empty-state"><p>Trash emptied</p></div>';
    renderMessages(); renderFolders();
    toast(r.deleted ? 'Deleted ' + r.deleted + ' messages' : 'Trash is already empty', 'success');
  }).catch(function(e) { toast(e.message, 'error'); });
}

function refreshFolder() { if (S.folder) loadFolders(); }

// ── Contact Autocomplete ──
var acState = { input: null, dd: null, items: [], idx: -1, timer: null };

function acAttach(inputId, ddId) {
  var inp = document.getElementById(inputId);
  var dd = document.getElementById(ddId);
  inp.addEventListener('input', function() { acDebounce(inp, dd); });
  inp.addEventListener('keydown', function(e) { acKey(e, inp, dd); });
  inp.addEventListener('blur', function() { setTimeout(function() { acHide(dd); }, 200); });
  inp.addEventListener('focus', function() { if (inp.value.length >= 2) acDebounce(inp, dd); });
}

function acDebounce(inp, dd) {
  clearTimeout(acState.timer);
  var val = acCurrentPart(inp);
  if (val.length < 2) { acHide(dd); return; }
  acState.timer = setTimeout(function() { acFetch(val, inp, dd); }, 200);
}

function acCurrentPart(inp) {
  var val = inp.value;
  var pos = inp.selectionStart;
  var before = val.substring(0, pos);
  var after = val.substring(pos);
  // Find the current comma-separated part being typed
  var parts = before.split(',');
  var current = parts[parts.length - 1].trim();
  return current;
}

function acFetch(q, inp, dd) {
  api('contacts?q=' + encodeURIComponent(q)).then(function(results) {
    if (!results.length) { acHide(dd); return; }
    acState.items = results;
    acState.idx = -1;
    dd.innerHTML = '';
    for (var i = 0; i < results.length; i++) {
      var div = document.createElement('div');
      div.className = 'ac-item';
      div.setAttribute('data-idx', i);
      var name = esc(results[i].name || results[i].email);
      var email = esc(results[i].email);
      div.innerHTML = '<span class="ac-name">' + name + '</span>' + (results[i].name ? '<span class="ac-email">' + email + '</span>' : '');
      div.addEventListener('mousedown', (function(idx) { return function(e) { e.preventDefault(); acSelect(idx, inp, dd); }; })(i));
      dd.appendChild(div);
    }
    dd.classList.add('show');
  }).catch(function() { acHide(dd); });
}

function acKey(e, inp, dd) {
  if (!dd.classList.contains('show')) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    acState.idx = Math.min(acState.idx + 1, acState.items.length - 1);
    acHighlight(dd);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    acState.idx = Math.max(acState.idx - 1, 0);
    acHighlight(dd);
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    if (acState.idx >= 0) { e.preventDefault(); acSelect(acState.idx, inp, dd); }
  } else if (e.key === 'Escape') {
    acHide(dd);
  }
}

function acHighlight(dd) {
  var items = dd.querySelectorAll('.ac-item');
  for (var i = 0; i < items.length; i++) items[i].classList.remove('active');
  if (acState.idx >= 0 && items[acState.idx]) items[acState.idx].classList.add('active');
}

function acSelect(idx, inp, dd) {
  var c = acState.items[idx];
  if (!c) return;
  var val = inp.value;
  var pos = inp.selectionStart;
  var before = val.substring(0, pos);
  var after = val.substring(pos);
  // Replace the current comma-separated part
  var parts = before.split(',');
  parts[parts.length - 1] = (c.name ? c.name + ' <' + c.email + '>' : c.email);
  inp.value = parts.join(', ') + (after ? ', ' + after : '');
  inp.focus();
  acHide(dd);
}

function acHide(dd) { dd.classList.remove('show'); dd.innerHTML = ''; acState.idx = -1; }

// Init autocomplete on compose fields
acAttach('cTo', 'acTo');
acAttach('cCc', 'acCc');

function openCompose() {
  S.draftUid = null;
  document.getElementById('composeOverlay').classList.add('show'); initEditor();
  startDraftAutoSave();
}

function closeCompose(opts) {
  var skipSave = opts && opts.skipSave;
  clearTimeout(S.draftAutoSave);
  if (!skipSave) autoSaveDraft(true); // save before closing
  document.getElementById('composeOverlay').classList.remove('show');
  document.getElementById('cTo').value=''; document.getElementById('cCc').value='';
  document.getElementById('cSubj').value='';
  var ed = document.getElementById('cEditor');
  if (ed) ed.innerHTML = '';
  document.getElementById('cBody').value = '';
  S.plainTextMode = false;
  setEditorMode(false);
  window._composeFiles = [];
  var fl = document.getElementById('composeFileList');
  if (fl) fl.innerHTML = '';
  S.draftUid = null;
}
function replyMsg() {
  if (!S.activeMsg) return; openCompose();
  var match = S.activeMsg.from.match(/<(.+)>/);
  document.getElementById('cTo').value = match ? match[1] : S.activeMsg.from;
  document.getElementById('cSubj').value = 'Re: ' + S.activeMsg.subject.replace(/^Re: /,'');
  var ed = document.getElementById('cEditor');
  var date = new Date(S.activeMsg.date).toLocaleString();
  var quoteFrom = esc(S.activeMsg.from);
  if (S.activeMsg.htmlBody) {
    ed.innerHTML = '<br><br><blockquote style="border-left:3px solid #2e272a;margin:8px 0;padding:4px 12px;color:#948a8c">On ' + esc(date) + ', ' + quoteFrom + ' wrote:<br>' + S.activeMsg.htmlBody + '</blockquote>';
  } else {
    ed.innerHTML = '<br><br><blockquote style="border-left:3px solid #2e272a;margin:8px 0;padding:4px 12px;color:#948a8c">On ' + esc(date) + ', ' + quoteFrom + ' wrote:<br>' + esc(S.activeMsg.textBody||'').replace(/\n/g, '<br>') + '</blockquote>';
  }
  ed.focus();
  var range = document.createRange();
  range.setStart(ed, 0);
  range.collapse(true);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
function forwardMsg() {
  if (!S.activeMsg) return; openCompose();
  document.getElementById('cSubj').value = 'Fwd: ' + S.activeMsg.subject.replace(/^Fwd: /,'');
  var ed = document.getElementById('cEditor');
  var fwdHeader = '---------- Forwarded message ----------<br>From: ' + esc(S.activeMsg.from) + '<br>Date: ' + esc(new Date(S.activeMsg.date).toLocaleString()) + '<br>Subject: ' + esc(S.activeMsg.subject) + '<br><br>';
  if (S.activeMsg.htmlBody) {
    ed.innerHTML = '<br><br>' + fwdHeader + S.activeMsg.htmlBody;
  } else {
    ed.innerHTML = '<br><br>' + fwdHeader + esc(S.activeMsg.textBody||'').replace(/\n/g, '<br>');
  }
  ed.focus();
  var range = document.createRange();
  range.setStart(ed, 0);
  range.collapse(true);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
function doSend() {
  var to = document.getElementById('cTo').value;
  if (!to) { toast('Add a recipient', 'error'); return; }
  var text, html;
  if (S.plainTextMode) {
    text = document.getElementById('cBody').value;
    html = null;
  } else {
    var ed = document.getElementById('cEditor');
    html = ed.innerHTML;
    var div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('br').forEach(function(b) { b.replaceWith('\n'); });
    div.querySelectorAll('p, div, li, blockquote, h1, h2, h3, h4, h5, h6').forEach(function(el) {
      el.insertAdjacentText('beforeend', '\n');
    });
    text = (div.textContent || div.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    var tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    var hasFormatting = tempDiv.querySelector('b,i,u,s,a,ul,ol,blockquote,h1,h2,h3,li,em,strong,center');
    if (!hasFormatting && html.replace(/<br\s*\/?>/gi,'\n').replace(/<div>/gi,'n').replace(/<\/div>/gi,'').replace(/<[^>]+>/g,'').trim() === text) {
      html = null;
    }
  }
  // Use FormData to support file attachments
  var fd = new FormData();
  fd.append('to', to);
  fd.append('cc', document.getElementById('cCc').value);
  fd.append('subject', document.getElementById('cSubj').value);
  fd.append('text', text);
  if (html) fd.append('html', html);
  // Add attachments
  if (window._composeFiles && window._composeFiles.length) {
    for (var i = 0; i < window._composeFiles.length; i++) {
      fd.append('attachments', window._composeFiles[i]);
    }
  }
  fetch('/api/send', { method: 'POST', credentials: 'include', body: fd }).then(function(r) {
    if (r.status === 401) { showLogin(); throw new Error('Auth required'); }
    return r.json();
  }).then(function(j) {
    if (j.error) { toast(j.error, 'error'); throw new Error(j.error); }
    toast('Sent', 'success');
    // Delete the draft if this was a draft compose
    if (S.draftUid) {
      api('delete', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ folder: 'Drafts', uids: [S.draftUid] }) }).catch(function() {});
    }
    closeCompose({ skipSave: true });
  }).catch(function(e) { toast(e.message, 'error'); });
}

// ── Drafts ──
function getComposeContent() {
  var to = (document.getElementById('cTo').value || '').trim();
  var cc = (document.getElementById('cCc').value || '').trim();
  var subject = (document.getElementById('cSubj').value || '').trim();
  var text = '', html = '';
  if (S.plainTextMode) {
    text = (document.getElementById('cBody').value || '').trim();
  } else {
    var ed = document.getElementById('cEditor');
    html = (ed ? ed.innerHTML : '').trim();
    var div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('br').forEach(function(b) { b.replaceWith('\n'); });
    div.querySelectorAll('p, div, li, blockquote').forEach(function(el) { el.insertAdjacentText('beforeend', '\n'); });
    text = (div.textContent || div.innerText || '').trim();
  }
  return { to: to, cc: cc, subject: subject, text: text, html: html };
}

function hasComposeContent() {
  var c = getComposeContent();
  return c.to || c.subject || c.text;
}

function autoSaveDraft(isClose) {
  if (!hasComposeContent()) return;
  var c = getComposeContent();
  // Skip if only a recipient with no body/subject (not worth saving)
  if (!c.text && !c.subject) return;
  api('drafts/save', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ to: c.to, cc: c.cc, subject: c.subject, text: c.text, html: c.html, draftUid: S.draftUid })
  }).then(function(r) {
    if (r.uid) S.draftUid = r.uid;
    if (isClose) {
      toast('Draft saved', 'success');
    } else {
      // Silent auto-save — show subtle indicator
      var btn = document.getElementById('draftSaveBtn');
      if (btn) btn.textContent = 'Saved ✓';
      setTimeout(function() { if (btn) btn.textContent = 'Save Draft'; }, 2000);
    }
    loadFolders(); // refresh Drafts count
  }).catch(function() {});
}

function startDraftAutoSave() {
  clearTimeout(S.draftAutoSave);
  S.draftAutoSave = setInterval(function() {
    if (document.getElementById('composeOverlay').classList.contains('show') && hasComposeContent()) {
      autoSaveDraft(false);
    }
  }, 30000); // auto-save every 30s
}

function openDraft(uid) {
  api('message?folder=Drafts&uid=' + uid).then(function(m) {
    S.draftUid = uid;
    document.getElementById('composeOverlay').classList.add('show');
    initEditor();
    document.getElementById('cTo').value = m.to || '';
    document.getElementById('cCc').value = m.cc || '';
    document.getElementById('cSubj').value = m.subject || '';
    var ed = document.getElementById('cEditor');
    if (ed) {
      if (m.htmlBody) ed.innerHTML = m.htmlBody;
      else if (m.textBody) ed.innerHTML = esc(m.textBody).replace(/\n/g, '<br>');
    }
    startDraftAutoSave();
  }).catch(function(e) { toast('Failed to load draft', 'error'); });
}


var _searchTimer = null;
document.getElementById('searchInput').addEventListener('input', function() {
  var q = (this.value || '').trim();
  clearTimeout(_searchTimer);
  if (!q) {
    // Empty search: reload current folder messages
    S._searchMode = false;
    loadMessages();
    return;
  }
  // Debounce: wait 400ms after user stops typing
  _searchTimer = setTimeout(function() { doSearch(q); }, 400);
});

function doSearch(q) {
  S._searchMode = true;
  var el = document.getElementById('msgScroll');
  el.innerHTML = '<div class="loading"><div class="spinner"></div> Searching\u2026</div>';
  api('search?q=' + encodeURIComponent(q) + '&folder=' + encodeURIComponent(S.folder)).then(function(r) {
    S.messages = r.messages || [];
    S.msgTotal = r.total || 0;
    document.getElementById('folderTitle').textContent = 'Search: ' + q;
    document.getElementById('folderCount').textContent = S.msgTotal ? S.msgTotal + ' results' : '';
    renderMessages();
  }).catch(function(e) {
    el.innerHTML = '<div class="empty-state"><p>Search failed: ' + esc(e.message) + '</p></div>';
  });
}
// ── Keyboard Shortcuts ──
document.addEventListener('keydown', function(e) {
  // Ignore if typing in an input, textarea, or compose is open
  var tag = (e.target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (document.getElementById('composeOverlay').classList.contains('show')) return;
  if (document.getElementById('loginOverlay').classList.contains('show')) return;
  if (document.getElementById('movePickerOverlay')) return;

  var key = e.key;

  // Delete / Backspace — delete active or selected messages
  if (key === 'Delete' || key === 'Backspace') {
    e.preventDefault();
    if (S.selected.size > 0) deleteUids(Array.from(S.selected));
    else if (S.activeUid) deleteUids([S.activeUid]);
    return;
  }

  // R — Reply
  if (key === 'r' || key === 'R') {
    if (S.activeMsg) replyMsg();
    return;
  }

  // F — Forward
  if (key === 'f' || key === 'F') {
    if (S.activeMsg) forwardMsg();
    return;
  }

  // E — Archive
  if (key === 'e' || key === 'E') {
    if (S.activeUid) archiveUid(S.activeUid);
    return;
  }

  // J — Next message
  if (key === 'j' || key === 'J') {
    if (!S.messages.length) return;
    var idx = -1;
    for (var i = 0; i < S.messages.length; i++) { if (S.messages[i].id === S.activeUid) { idx = i; break; } }
    if (idx < S.messages.length - 1) openMsg(S.messages[idx + 1].id);
    return;
  }

  // K — Previous message
  if (key === 'k' || key === 'K') {
    if (!S.messages.length) return;
    var idx = -1;
    for (var i = 0; i < S.messages.length; i++) { if (S.messages[i].id === S.activeUid) { idx = i; break; } }
    if (idx > 0) openMsg(S.messages[idx - 1].id);
    return;
  }

  // S — Toggle favorite
  if (key === 's' || key === 'S') {
    if (S.activeUid) doStar(S.activeUid);
    return;
  }

  // C — Compose
  if (key === 'c' || key === 'C') {
    openCompose();
    return;
  }

  // ? — Show shortcuts help
  if (key === '?') {
    toast('⌨ Shortcuts: J/K nav | R reply | F fwd | E archive | S star | C compose | Del delete', 'success');
    return;
  }
});

document.getElementById('lPass').addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin(); });
document.getElementById('lUser').addEventListener('keydown', function(e) { if (e.key === 'Enter') document.getElementById('lPass').focus(); });

fetch('/api/check', { credentials: 'include' }).then(function(r) { return r.json(); }).then(function(j) {
  if (j.connected) { hideLogin(); setConnected(true, { user: j.user, host: 'mail.nexusmail.cc' }); connectWS(); }
  else if (j.authenticated) { hideLogin(); connectWS(); }
  else showLogin();
}).catch(function() { showLogin(); });

// ── Message Context Menu ──
function msgContextMenu(e, uid) {
  closeMsgMenu();
  var msg = null;
  for (var i = 0; i < S.messages.length; i++) { if (S.messages[i].id === uid) { msg = S.messages[i]; break; } }
  if (!msg) return;
  var isStarred = (S.folder === 'Favorites');
  var menu = document.createElement('div');
  menu.className = 'msg-menu';
  menu.id = 'msgContextMenu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.innerHTML =
    '<div class="msg-menu-item" data-action="reply">' + svg('<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',14) + ' Reply</div>' +
    '<div class="msg-menu-item" data-action="forward">' + svg('<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',14) + ' Forward</div>' +
    '<div class="msg-menu-sep"></div>' +
    '<div class="msg-menu-item" data-action="archive">' + svg('<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',14) + ' Archive</div>' +
    '<div class="msg-menu-item" data-action="move">' + svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><polyline points="12 11 12 17"/><polyline points="9 14 12 11 15 14"/>',14) + ' Move to…</div>' +
    '<div class="msg-menu-sep"></div>' +
    '<div class="msg-menu-item" data-action="star">' + svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',14) + (S.folder === 'Favorites' ? ' Remove favorite' : ' Add favorite') + '</div>' +
    '<div class="msg-menu-sep"></div>' +
    '<div class="msg-menu-item danger" data-action="delete">' + svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',14) + ' Delete</div>';
  document.body.appendChild(menu);
  var rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
  var items = menu.querySelectorAll('.msg-menu-item');
  for (var i = 0; i < items.length; i++) {
    items[i].addEventListener('click', function() {
      var action = this.getAttribute('data-action');
      if (action === 'reply') fetchAndReply(uid);
      else if (action === 'forward') fetchAndForward(uid);
      else if (action === 'archive') archiveUid(uid);
      else if (action === 'move') { S._moveUids = [uid]; showMovePicker([uid], '1 message'); }
      else if (action === 'star') doStar(uid);
      else if (action === 'delete') deleteUids([uid]);
      closeMsgMenu();
    });
  }
  setTimeout(function() { document.addEventListener('click', closeMsgMenu, { once: true }); }, 10);
}

function closeMsgMenu() {
  var el = document.getElementById('msgContextMenu');
  if (el) el.remove();
}

function fetchAndReply(uid) {
  var listMsg = null;
  for (var i = 0; i < S.messages.length; i++) { if (S.messages[i].id === uid) { listMsg = S.messages[i]; break; } }
  if (!listMsg) { toast('Message not found', 'error'); return; }
  // If already loaded as activeMsg, use it directly
  if (S.activeMsg && S.activeMsg.id === uid) { replyMsg(); return; }
  // Otherwise fetch the full message then reply
  api('message?folder=' + encodeURIComponent(S.folder) + '&uid=' + uid).then(function(m) {
    S.activeMsg = m;
    replyMsg();
  }).catch(function() { toast('Failed to load message', 'error'); });
}

function fetchAndForward(uid) {
  var listMsg = null;
  for (var i = 0; i < S.messages.length; i++) { if (S.messages[i].id === uid) { listMsg = S.messages[i]; break; } }
  if (!listMsg) { toast('Message not found', 'error'); return; }
  if (S.activeMsg && S.activeMsg.id === uid) { forwardMsg(); return; }
  api('message?folder=' + encodeURIComponent(S.folder) + '&uid=' + uid).then(function(m) {
    S.activeMsg = m;
    forwardMsg();
  }).catch(function() { toast('Failed to load message', 'error'); });
}

function archiveUid(uid) {
  // Create Archive folder if needed, then move
  api('folders/create', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name: 'Archive' }) }).then(function() {
    return api('move', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ folder: S.folder, dest: 'Archive', uids: [uid] }) });
  }).catch(function(e) {
    // Folder might already exist, try move anyway
    if (e.message && e.message.indexOf('already exists') >= 0) {
      return api('move', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ folder: S.folder, dest: 'Archive', uids: [uid] }) });
    }
    throw e;
  }).then(function() {
    S.notifiedUids.add(uid); S.newUids.delete(uid);
    S.messages = S.messages.filter(function(m) { return m.id !== uid; });
    if (S.activeUid === uid) {
      S.activeUid = null; S.activeMsg = null;
      document.getElementById('msgView').innerHTML = '<div class="empty-state"><p>Archived</p></div>';
    }
    renderMessages(); renderFolders(); toast('Archived', 'success');
  }).catch(function(e) { toast(e.message, 'error'); });
}

function deleteUids(uids) {
  api('delete', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({folder:S.folder, uids:uids}) }).then(function() {
    S.messages = S.messages.filter(function(m) { return uids.indexOf(m.id) === -1; });
    if (S.activeUid && uids.indexOf(S.activeUid) >= 0) {
      S.activeUid = null; S.activeMsg = null;
      document.getElementById('msgView').innerHTML = '<div class="empty-state"><p>Deleted</p></div>';
    }
    S.selected.clear();
    renderMessages(); renderFolders(); toast('Deleted', 'success');
  }).catch(function(e) { toast(e.message, 'error'); });
}

// ── Folder Management & Move ──

function createFolder() {
  var name = prompt('New folder name:');
  if (!name || !name.trim()) return;
  api('folders/create', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ name: name.trim() })
  }).then(function() {
    toast('Folder created', 'success');
    loadFolders();
  }).catch(function(e) { toast(e.message, 'error'); });
}

function deleteFolder(path) {
  if (!confirm('Delete folder "' + path + '" and all its messages?')) return;
  api('folders/delete', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ path: path })
  }).then(function() {
    toast('Folder deleted', 'success');
    if (S.folder === path) { S.folder = null; }
    loadFolders();
  }).catch(function(e) { toast(e.message, 'error'); });
}

function showMovePicker(uids, label) {
  // Build a dropdown with all folders except current
  var folders = S.folders.filter(function(f) { return f.path !== S.folder; });
  if (!folders.length) { toast('No other folders to move to', 'error'); return; }

  // Use a simple prompt-style picker
  var html = '<div class="move-picker-overlay" id="movePickerOverlay" onclick="if(event.target===this)closeMovePicker()">';
  html += '<div class="move-picker">';
  html += '<div class="move-picker-head">Move ' + esc(label) + ' to…<button onclick="closeMovePicker()">✕</button></div>';
  html += '<div class="move-picker-list">';
  for (var i = 0; i < folders.length; i++) {
    html += '<div class="move-picker-item" data-folder="' + esc(folders[i].path) + '">';
    html += '<span class="f-icon">' + folderIcon(folders[i]) + '</span>';
    html += '<span>' + esc(folders[i].name) + '</span>';
    if (folders[i].unread) html += '<span class="f-badge has-unread" style="margin-left:auto">' + folders[i].unread + '</span>';
    html += '</div>';
  }
  html += '</div>';
  html += '<div class="move-picker-foot">';
  html += '<input id="moveNewFolder" placeholder="Or create new folder…" style="flex:1">';
  html += '<button class="btn btn-sm" onclick="moveCreateAndGo()">Create & Move</button>';
  html += '</div></div></div>';

  document.body.insertAdjacentHTML('beforeend', html);

  // Store the UIDs for the move
  S._moveUids = uids;
  S._moveLabel = label;

  var items = document.querySelectorAll('.move-picker-item');
  for (var i = 0; i < items.length; i++) {
    items[i].addEventListener('click', function() {
      doMoveTo(this.getAttribute('data-folder'));
    });
  }

  var inp = document.getElementById('moveNewFolder');
  inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && inp.value.trim()) moveCreateAndGo();
  });
  inp.focus();
}

function moveCreateAndGo() {
  var name = (document.getElementById('moveNewFolder').value || '').trim();
  if (!name) return;
  api('folders/create', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ name: name })
  }).then(function() {
    doMoveTo(name);
  }).catch(function(e) { toast(e.message, 'error'); });
}

function doMoveTo(dest) {
  var uids = S._moveUids;
  if (!uids || !uids.length) return;
  api('move', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ folder: S.folder, dest: dest, uids: uids })
  }).then(function() {
    // Track UIDs so polling doesn't treat moved messages as new
    for (var i = 0; i < uids.length; i++) { S.notifiedUids.add(uids[i]); S.newUids.delete(uids[i]); }
    S.messages = S.messages.filter(function(m) { return uids.indexOf(m.id) === -1; });
    if (S.activeUid && uids.indexOf(S.activeUid) >= 0) {
      S.activeUid = null; S.activeMsg = null;
      document.getElementById('msgView').innerHTML = '<div class="empty-state"><p>Moved to ' + esc(dest) + '</p></div>';
    }
    S.selected.clear();
    closeMovePicker();
    renderMessages(); renderFolders();
    toast('Moved to ' + dest, 'success');
  }).catch(function(e) { toast(e.message, 'error'); });
}

function closeMovePicker() {
  var el = document.getElementById('movePickerOverlay');
  if (el) el.remove();
  S._moveUids = null;
}

function moveMsg() {
  if (!S.activeUid) return;
  showMovePicker([S.activeUid], '1 message');
}

function moveSelected() {
  if (!S.selected.size) return;
  showMovePicker(Array.from(S.selected), S.selected.size + ' messages');
}
// ── Rules Management ──

function openRules() {
  api('rules').then(function(rules) {
    renderRulesModal(rules || []);
  }).catch(function(e) { toast(e.message, 'error'); });
}

function renderRulesModal(rules) {
  var html = '<div class="rules-overlay" id="rulesOverlay" onclick="if(event.target===this)closeRules()">';
  html += '<div class="rules-modal">';
  html += '<div class="rules-head">Mail Rules <button onclick="closeRules()">✕</button></div>';
  html += '<div class="rules-list">';

  if (!rules.length) {
    html += '<div class="rules-empty">No rules yet. Click "Add Rule" to create one.</div>';
  }

  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    html += '<div class="rule-card ' + (r.enabled ? '' : 'disabled') + '" data-id="' + r.id + '">';
    html += '<div class="rule-header">';
    html += '<span class="rule-name">' + esc(r.name) + '</span>';
    html += '<div class="rule-actions">';
    html += '<label class="rule-toggle"><input type="checkbox" ' + (r.enabled ? 'checked' : '') + ' onchange="toggleRule(\'' + r.id + '\', this.checked)"> ON</label>';
    html += '<button class="btn btn-sm" onclick="editRule(\'' + r.id + '\')">Edit</button>';
    html += '<button class="btn btn-sm btn-danger" onclick="removeRule(\'' + r.id + '\')">Delete</button>';
    html += '</div></div>';
    html += '<div class="rule-summary">' + ruleSummary(r) + '</div>';
    html += '</div>';
  }

  html += '</div>';
  html += '<div class="rules-foot">';
  html += '<button class="btn btn-primary" onclick="addRule()">+ Add Rule</button>';
  html += '<button class="btn" onclick="runRulesNow()">Run Rules Now</button>';
  html += '</div></div></div>';
  document.body.insertAdjacentHTML('beforeend', html);
}

function ruleSummary(r) {
  var parts = [];
  var c = r.conditions || {};
  if (c.from) parts.push('From: ' + c.from);
  if (c.to) parts.push('To: ' + c.to);
  if (c.attachment) parts.push('Attachment: ' + c.attachment);
  if (c.timeAfter || c.timeBefore) parts.push('Time: ' + (c.timeAfter || '...') + '–' + (c.timeBefore || '...'));
  var action = r.action === 'move' ? 'Move to ' + r.dest : r.action === 'delete' ? 'Delete' : 'Mark as read';
  return (parts.length ? parts.join(' · ') : 'No conditions') + ' → ' + action;
}

function closeRules() {
  var el = document.getElementById('rulesOverlay');
  if (el) el.remove();
}

function addRule() {
  closeRules();
  showRuleEditor(null);
}

function editRule(id) {
  api('rules').then(function(rules) {
    var rule = null;
    for (var i = 0; i < rules.length; i++) { if (rules[i].id === id) { rule = rules[i]; break; } }
    closeRules();
    if (rule) showRuleEditor(rule);
  }).catch(function() {});
}

function showRuleEditor(rule) {
  var isNew = !rule;
  rule = rule || { name: '', conditions: {}, action: 'move', dest: '', enabled: true };

  var html = '<div class="rules-overlay" id="ruleEditorOverlay" onclick="if(event.target===this)closeRuleEditor()">';
  html += '<div class="rules-modal rule-editor">';
  html += '<div class="rules-head">' + (isNew ? 'New Rule' : 'Edit Rule') + ' <button onclick="closeRuleEditor()">✕</button></div>';
  html += '<div class="rule-form">';

  html += '<div class="field"><label>Rule Name</label><input id="ruleName" value="' + esc(rule.name) + '" placeholder="e.g. Route support emails"></div>';

  html += '<div class="rule-section-label">Conditions (all must match)</div>';

  html += '<div class="field"><label>Sender email contains</label><input id="ruleFrom" value="' + esc(rule.conditions.from || '') + '" placeholder="e.g. noreply@github.com (comma-separated)"></div>';
  html += '<div class="field"><label>Recipient email contains</label><input id="ruleTo" value="' + esc(rule.conditions.to || '') + '" placeholder="e.g. support@nexusmail.cc (comma-separated)"></div>';
  html += '<div class="field"><label>Has attachment type</label><input id="ruleAttach" value="' + esc(rule.conditions.attachment || '') + '" placeholder="e.g. .pdf, .zip"></div>';

  html += '<div class="field"><label>Received after (24h)</label><input id="ruleTimeAfter" value="' + esc(rule.conditions.timeAfter || '') + '" placeholder="e.g. 09:00"></div>';
  html += '<div class="field"><label>Received before (24h)</label><input id="ruleTimeBefore" value="' + esc(rule.conditions.timeBefore || '') + '" placeholder="e.g. 17:00"></div>';

  html += '<div class="rule-section-label">Action</div>';
  html += '<div class="field"><label>Action</label><select id="ruleAction">';
  html += '<option value="move"' + (rule.action === 'move' ? ' selected' : '') + '>Move to folder</option>';
  html += '<option value="delete"' + (rule.action === 'delete' ? ' selected' : '') + '>Delete</option>';
  html += '<option value="markread"' + (rule.action === 'markread' ? ' selected' : '') + '>Mark as read</option>';
  html += '</select></div>';

  html += '<div class="field" id="ruleDestField"><label>Destination folder</label><input id="ruleDest" value="' + esc(rule.dest || '') + '" placeholder="e.g. Support, Newsletter"></div>';

  html += '</div>';
  html += '<div class="rules-foot">';
  html += '<button class="btn btn-primary" onclick="saveRuleEditor(\'' + (rule.id || '') + '\')">' + (isNew ? 'Create Rule' : 'Save Changes') + '</button>';
  html += '<button class="btn" onclick="closeRuleEditor()">Cancel</button>';
  html += '</div></div></div>';
  document.body.insertAdjacentHTML('beforeend', html);

  // Hide dest field unless action is move
  var actionSel = document.getElementById('ruleAction');
  actionSel.addEventListener('change', function() {
    document.getElementById('ruleDestField').style.display = this.value === 'move' ? '' : 'none';
  });
  actionSel.dispatchEvent(new Event('change'));
}

function saveRuleEditor(id) {
  var rule = {
    name: document.getElementById('ruleName').value.trim(),
    conditions: {
      from: document.getElementById('ruleFrom').value.trim(),
      to: document.getElementById('ruleTo').value.trim(),
      attachment: document.getElementById('ruleAttach').value.trim(),
      timeAfter: document.getElementById('ruleTimeAfter').value.trim(),
      timeBefore: document.getElementById('ruleTimeBefore').value.trim()
    },
    action: document.getElementById('ruleAction').value,
    dest: document.getElementById('ruleDest').value.trim(),
    enabled: true
  };

  if (!rule.name) { toast('Rule name required', 'error'); return; }
  if (rule.action === 'move' && !rule.dest) { toast('Destination folder required', 'error'); return; }
  var hasCondition = rule.conditions.from || rule.conditions.to || rule.conditions.attachment || rule.conditions.timeAfter || rule.conditions.timeBefore;
  if (!hasCondition) { toast('At least one condition required', 'error'); return; }

  var method = id ? 'PUT' : 'POST';
  var url = id ? 'rules/' + id : 'rules';
  api(url, { method: method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(rule) }).then(function() {
    closeRuleEditor();
    toast(id ? 'Rule updated' : 'Rule created', 'success');
    openRules();
  }).catch(function(e) { toast(e.message, 'error'); });
}

function closeRuleEditor() {
  var el = document.getElementById('ruleEditorOverlay');
  if (el) el.remove();
}

function toggleRule(id, enabled) {
  api('rules').then(function(rules) {
    var rule = null;
    for (var i = 0; i < rules.length; i++) { if (rules[i].id === id) { rule = rules[i]; break; } }
    if (!rule) return;
    rule.enabled = enabled;
    api('rules/' + id, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(rule) }).then(function() {
      toast(enabled ? 'Rule enabled' : 'Rule disabled', 'success');
      closeRules(); openRules();
    });
  }).catch(function() {});
}

function removeRule(id) {
  if (!confirm('Delete this rule?')) return;
  api('rules/' + id, { method: 'DELETE' }).then(function() {
    toast('Rule deleted', 'success');
    closeRules(); openRules();
  }).catch(function(e) { toast(e.message, 'error'); });
}

function runRulesNow() {
  toast('Running rules...');
  api('rules/apply', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ folder: S.folder || 'INBOX' }) }).then(function(r) {
    toast(r.applied && r.applied.length ? 'Applied ' + r.applied.length + ' rule(s)' : 'No rules matched', 'success');
    loadFolders(); loadMessages();
  }).catch(function(e) { toast(e.message, 'error'); });
}


// ── Rich Text Editor ──
var _editorInited = false;
function initEditor() {
  if (_editorInited) return;
  _editorInited = true;
  var toolbar = document.getElementById('editorToolbar');
  if (!toolbar) return;
  var buttons = toolbar.querySelectorAll('button[data-cmd]');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('mousedown', function(e) {
      e.preventDefault();
      var cmd = this.getAttribute('data-cmd');

      if (cmd === 'createLink') {
        var sel = window.getSelection();
        if (sel.rangeCount > 0 && !sel.isCollapsed) {
          var url = prompt('Enter URL:');
          if (url) document.execCommand('createLink', false, url);
        } else {
          toast('Select text to link', 'error');
        }
        return;
      }
      document.execCommand(cmd, false, null);
      updateToolbarState();
    });
  }
  document.addEventListener('selectionchange', function() {
    var ed = document.getElementById('cEditor');
    if (ed && (ed.contains(document.activeElement) || (window.getSelection().rangeCount > 0 && ed.contains(window.getSelection().anchorNode)))) {
      updateToolbarState();
    }
  });
}

function updateToolbarState() {
  var toolbar = document.getElementById('editorToolbar');
  if (!toolbar) return;
  var buttons = toolbar.querySelectorAll('button[data-cmd]');
  var stateCmds = ['bold','italic','underline','strikeThrough','insertUnorderedList','insertOrderedList','justifyLeft','justifyCenter','justifyRight'];
  for (var i = 0; i < buttons.length; i++) {
    var cmd = buttons[i].getAttribute('data-cmd');
    if (stateCmds.indexOf(cmd) >= 0) {
      try {
        buttons[i].classList.toggle('active', document.queryCommandState(cmd));
      } catch(e) {}
    }
  }
}

function toggleEditorMode() {
  S.plainTextMode = !S.plainTextMode;
  setEditorMode(S.plainTextMode);
}

function setEditorMode(plain) {
  var ed = document.getElementById('cEditor');
  var tb = document.getElementById('cBody');
  var toolbar = document.getElementById('editorToolbar');
  var modeBar = document.getElementById('editorModeBar');
  var modeRich = document.getElementById('modeRich');
  var modePlain = document.getElementById('modePlain');
  S.plainTextMode = plain;
  if (plain) {
    if (ed) {
      var div = document.createElement('div');
      div.innerHTML = ed.innerHTML;
      div.querySelectorAll('br').forEach(function(b) { b.replaceWith('\n'); });
      div.querySelectorAll('p, div, li, blockquote').forEach(function(el) { el.insertAdjacentText('beforeend', '\n'); });
      tb.value = (div.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }
    if (ed) ed.style.display = 'none';
    tb.style.display = '';
    if (toolbar) { toolbar.style.opacity = '0.4'; toolbar.style.pointerEvents = 'none'; }
    if (modeBar) { modeBar.style.display = 'flex'; }
    if (modeRich) modeRich.classList.remove('active');
    if (modePlain) modePlain.classList.add('active');
  } else {
    if (tb.value) {
      ed.innerHTML = tb.value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g, '<br>');
    }
    if (ed) ed.style.display = '';
    tb.style.display = 'none';
    if (toolbar) { toolbar.style.opacity = ''; toolbar.style.pointerEvents = ''; }
    if (modeBar) { modeBar.style.display = 'flex'; }
    if (modeRich) modeRich.classList.add('active');
    if (modePlain) modePlain.classList.remove('active');

  }
}
