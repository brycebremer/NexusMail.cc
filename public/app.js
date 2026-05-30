var S = {
  connected: false, folder: null, folders: [],
  messages: [], selected: new Set(),
  activeUid: null, activeMsg: null,
  ws: null, allSelected: false, showHtml: false,
  notifiedUids: new Set(),
  newUids: new Set(),   // UIDs that just arrived — for highlight animation
  initialized: false  // seed existing UIDs on first load so they don't all pulse
};

function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
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
      // m.read === true means UNREAD in this codebase (confusing but correct)
      if (m.read && !S.notifiedUids.has(m.id)) {
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
  if (!u || !p) { toast('Enter username and password', 'error'); return; }
  toast('Signing in...');
  api('login', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ username: u, password: p })
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
    if (data.type === 'imap:flagsChanged') { if (S.folder === data.data.path) loadMessages(); }
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
    html += '<span class="f-name">' + esc(f.name) + '</span>';
    if (f.unread) html += '<span class="f-badge has-unread">' + f.unread + '</span>';
    else if (f.total) html += '<span class="f-badge">' + f.total + '</span>';
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

function selectFolder(path) {
  S.folder = path; S.selected.clear(); S.activeUid = null; S.activeMsg = null; S.allSelected = false;
  renderFolders(); loadMessages();
  document.getElementById('msgView').innerHTML = '<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" style="opacity:.3"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg><p>Select a message</p></div>';
}

function loadMessages() {
  var el = document.getElementById('msgScroll');
  el.innerHTML = '<div class="loading"><div class="spinner"></div> Loading\u2026</div>';
  api('messages?folder=' + encodeURIComponent(S.folder) + '&limit=80').then(function(r) {
    S.messages = r.messages || [];
    document.getElementById('folderTitle').textContent = S.folder;
    document.getElementById('folderCount').textContent = r.total ? r.total + ' messages' : '';
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

function renderMessages() {
  var q = (document.getElementById('searchInput').value || '').toLowerCase();
  var msgs = S.messages;
  if (q) msgs = msgs.filter(function(m) { return m.subject.toLowerCase().indexOf(q) >= 0 || m.from.toLowerCase().indexOf(q) >= 0; });
  if (!msgs.length) { document.getElementById('msgScroll').innerHTML = '<div class="empty-state"><p>No messages</p></div>'; return; }
  var html = '';
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    var isNew = S.newUids.has(m.id);
    var classes = 'msg-row';
    if (m.id === S.activeUid) classes += ' active';
    if (!m.read) classes += ' unread';
    if (isNew) classes += ' new-msg';
    if (S.selected.has(m.id)) classes += ' selected';
    html += '<div class="' + classes + '" data-uid="' + m.id + '">';
    html += '<div class="m-sel" data-uid="' + m.id + '">' + (S.selected.has(m.id) ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--accent)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>') + '</div>';
    html += '<span class="m-from">' + esc(m.from.split('<')[0].trim()) + '</span>';
    html += '<span class="m-subj">' + esc(m.subject) + '</span>';
    html += '<div class="m-meta"><span class="m-date">' + fmtDate(m.date) + '</span>';
    html += '<div class="m-flags"><span class="star ' + (m.starred?'on':'') + '" data-uid="' + m.id + '" data-starred="' + m.starred + '" style="color:' + (m.starred?'var(--warn)':'') + '">' + svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',12) + '</span>';
    if (m.hasAttachments) html += svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>', 12);
    html += '</div></div></div>';
  }
  document.getElementById('msgScroll').innerHTML = html;
  var rows = document.querySelectorAll('.msg-row');
  for (var i = 0; i < rows.length; i++) {
    rows[i].addEventListener('click', function(e) {
      if (e.target.closest('.star') || e.target.closest('.m-sel')) return;
      var uid = parseInt(this.getAttribute('data-uid'));
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
      var starred = this.getAttribute('data-starred') === 'true';
      doStar(uid, !starred);
    });
  }
}

function openMsg(uid) {
  S.activeUid = uid;
  var el = document.getElementById('msgView');
  el.innerHTML = '<div class="loading"><div class="spinner"></div> Loading\u2026</div>';
  api('message?folder=' + encodeURIComponent(S.folder) + '&uid=' + uid).then(function(m) {
    S.activeMsg = m;
    S.showHtml = false;

    var bodyContent;
    if (m.htmlBody) {
      bodyContent = '<div style="padding:4px 22px"><button class="btn btn-sm" id="toggleHtmlBtn">View as HTML</button></div>' +
        '<div class="ev-body">' + esc(m.textBody || 'No content') + '</div>' +
        '<iframe id="htmlFrame" sandbox="allow-same-origin" style="display:none;width:calc(100% - 44px);border:none;margin:0 22px;background:#fff;border-radius:4px"></iframe>';
    } else {
      bodyContent = '<div class="ev-body">' + esc(m.textBody || 'No content') + '</div>';
    }

    el.innerHTML = '<div class="ev-header"><h2>' + esc(m.subject) + '</h2>' +
      '<div class="ev-meta"><span class="label">From</span><span class="value">' + esc(m.from) + '</span>' +
      '<span class="label">To</span><span class="value">' + esc(m.to) + '</span>' +
      (m.cc ? '<span class="label">CC</span><span class="value">' + esc(m.cc) + '</span>' : '') +
      '<span class="label">Date</span><span class="value">' + new Date(m.date).toLocaleString() + '</span></div></div>' +
      '<div class="ev-actions"><button class="btn btn-sm" onclick="replyMsg()">' + svg('<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',14) + ' Reply</button>' +
      '<button class="btn btn-sm" onclick="forwardMsg()">' + svg('<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',14) + ' Forward</button>' +
      '<button class="btn btn-sm" onclick="moveMsg()">' + svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><polyline points="12 11 12 17"/><polyline points="9 14 12 11 15 14"/>',14) + ' Move</button>' +
      '<button class="btn btn-sm btn-danger" onclick="deleteMsg()">' + svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',14) + ' Delete</button></div>' +
      bodyContent;

    var toggleBtn = document.getElementById('toggleHtmlBtn');
    var htmlFrame = document.getElementById('htmlFrame');
    if (toggleBtn && htmlFrame) {
      toggleBtn.addEventListener('click', function() {
        if (!S.showHtml) {
          var doc = htmlFrame.contentDocument || htmlFrame.contentWindow.document;
          doc.open(); doc.write(m.htmlBody); doc.close();
          htmlFrame.style.display = 'block';
          setTimeout(function() {
            try { htmlFrame.style.height = doc.body.scrollHeight + 20 + 'px'; } catch(e) {}
          }, 100);
          document.querySelector('.ev-body').style.display = 'none';
          toggleBtn.textContent = 'View as Text';
          S.showHtml = true;
        } else {
          htmlFrame.style.display = 'none';
          document.querySelector('.ev-body').style.display = '';
          toggleBtn.textContent = 'View as HTML';
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

function doStar(uid, starred) {
  // Starring moves to Favorites folder, unstarring moves back to INBOX
  if (starred) {
    api('folders/create', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name: 'Favorites' }) }).catch(function() {}).then(function() {
      return api('move', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ folder: S.folder, dest: 'Favorites', uids: [uid] }) });
    }).then(function() {
      api('star', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ folder: 'Favorites', uid: uid, starred: true }) }).catch(function() {});
      S.messages = S.messages.filter(function(m) { return m.id !== uid; });
      if (S.activeUid === uid) {
        S.activeUid = null; S.activeMsg = null;
        document.getElementById('msgView').innerHTML = '<div class="empty-state"><p>Moved to Favorites</p></div>';
      }
      renderMessages(); renderFolders(); toast('Added to Favorites', 'success');
    }).catch(function(e) { toast(e.message, 'error'); });
  } else {
    api('move', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ folder: S.folder, dest: 'INBOX', uids: [uid] }) }).then(function() {
      api('star', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ folder: 'INBOX', uid: uid, starred: false }) }).catch(function() {});
      S.messages = S.messages.filter(function(m) { return m.id !== uid; });
      if (S.activeUid === uid) {
        S.activeUid = null; S.activeMsg = null;
        document.getElementById('msgView').innerHTML = '<div class="empty-state"><p>Removed from Favorites</p></div>';
      }
      renderMessages(); renderFolders(); toast('Removed from Favorites', 'success');
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

function refreshFolder() { if (S.folder) loadFolders(); }

function openCompose() { document.getElementById('composeOverlay').classList.add('show'); }
function closeCompose() {
  document.getElementById('composeOverlay').classList.remove('show');
  document.getElementById('cTo').value=''; document.getElementById('cCc').value='';
  document.getElementById('cSubj').value=''; document.getElementById('cBody').value='';
}
function replyMsg() {
  if (!S.activeMsg) return; openCompose();
  var match = S.activeMsg.from.match(/<(.+)>/);
  document.getElementById('cTo').value = match ? match[1] : S.activeMsg.from;
  document.getElementById('cSubj').value = 'Re: ' + S.activeMsg.subject.replace(/^Re: /,'');
  document.getElementById('cBody').value = '\n\n---\n' + (S.activeMsg.textBody||'');
}
function forwardMsg() {
  if (!S.activeMsg) return; openCompose();
  document.getElementById('cSubj').value = 'Fwd: ' + S.activeMsg.subject.replace(/^Fwd: /,'');
  document.getElementById('cBody').value = '\n\n--- Forwarded ---\nFrom: '+S.activeMsg.from+'\n\n'+(S.activeMsg.textBody||'');
}
function doSend() {
  var to = document.getElementById('cTo').value;
  if (!to) { toast('Add a recipient', 'error'); return; }
  api('send', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
    to: to, cc: document.getElementById('cCc').value,
    subject: document.getElementById('cSubj').value,
    text: document.getElementById('cBody').value
  })}).then(function() { toast('Sent', 'success'); closeCompose(); }).catch(function(e) { toast(e.message, 'error'); });
}

document.getElementById('searchInput').addEventListener('input', function() { renderMessages(); });
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
  var isStarred = msg.starred;
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
    '<div class="msg-menu-item" data-action="star">' + svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',14) + (isStarred ? ' Remove favorite' : ' Add favorite') + '</div>' +
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
      if (action === 'reply') replyToUid(uid);
      else if (action === 'forward') forwardUid(uid);
      else if (action === 'archive') archiveUid(uid);
      else if (action === 'move') { S._moveUids = [uid]; showMovePicker([uid], '1 message'); }
      else if (action === 'star') doStar(uid, !isStarred);
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

function replyToUid(uid) {
  var msg = null;
  for (var i = 0; i < S.messages.length; i++) { if (S.messages[i].id === uid) { msg = S.messages[i]; break; } }
  if (!msg) { toast('Message not found', 'error'); return; }
  openCompose();
  var match = msg.from.match(/<(.+)>/);
  document.getElementById('cTo').value = match ? match[1] : msg.from;
  document.getElementById('cSubj').value = 'Re: ' + msg.subject.replace(/^Re: /,'');
  document.getElementById('cBody').value = '';
}

function forwardUid(uid) {
  var msg = null;
  for (var i = 0; i < S.messages.length; i++) { if (S.messages[i].id === uid) { msg = S.messages[i]; break; } }
  if (!msg) { toast('Message not found', 'error'); return; }
  openCompose();
  document.getElementById('cTo').value = '';
  document.getElementById('cSubj').value = 'Fwd: ' + msg.subject.replace(/^Fwd: /,'');
  document.getElementById('cBody').value = '';
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
