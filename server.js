const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Session store with automatic cleanup ──
const SESSIONS = new Map();
const SESSION_MAX_AGE = 86400000; // 24h

// Clean expired sessions every 10 minutes
setInterval(function() {
  const now = Date.now();
  for (const [sid, s] of SESSIONS) {
    if (s.exp <= now) SESSIONS.delete(sid);
  }
}, 600000);

// Simple in-memory rate limiter for login
const loginAttempts = new Map();
const LOGIN_WINDOW = 60000;
const LOGIN_MAX = 8;

function checkLoginRate(ip) {
  const now = Date.now();
  let attempts = loginAttempts.get(ip);
  if (!attempts || now - attempts.ts > LOGIN_WINDOW) {
    loginAttempts.set(ip, { ts: now, count: 1 });
    return true;
  }
  attempts.count++;
  return attempts.count <= LOGIN_MAX;
}

function getMailUser(username) {
  return username.toLowerCase() + '@nexusmail.cc';
}

function checkAuth(req) {
  var cookie = req.headers.cookie || '';
  var m = cookie.match(/mp=([^;]+)/);
  if (m) {
    var s = SESSIONS.get(m[1]);
    if (s && s.exp > Date.now()) return s;
    if (s) SESSIONS.delete(m[1]); // purge expired
  }
  return null;
}

function requireAuth(req, res, next) {
  var s = checkAuth(req);
  if (s) { req.session = s; return next(); }
  res.status(401).json({ error: 'Auth required' });
}

app.post('/api/login', function(req, res) {
  var ip = req.ip || req.connection.remoteAddress;
  if (!checkLoginRate(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in a minute.' });
  }
  var username = req.body.username || '';
  var password = req.body.password || '';
  if (!username || !password) return res.status(401).json({ error: 'Enter username and password' });

  var mailUser = getMailUser(username);
  var client = new ImapFlow({
    host: 'mail.nexusmail.cc', port: 993, secure: true,
    auth: { user: mailUser, pass: password }, logger: false, emitLogs: false,
  });
  client.connect().then(function() {
    if (imapClient) { try { imapClient.logout(); } catch(e) {} }
    imapClient = client;
    config = {
      imapHost: 'mail.nexusmail.cc', imapPort: 993, imapTLS: 'ssl',
      imapUser: mailUser, imapPass: password,
      smtpHost: 'mail.nexusmail.cc', smtpPort: 587, displayName: username
    };
    smtpTransport = nodemailer.createTransport({
      host: 'mail.nexusmail.cc', port: 587, secure: false,
      auth: { user: mailUser, pass: password },
    });
    var sid = crypto.randomBytes(24).toString('hex');
    SESSIONS.set(sid, { user: mailUser, pass: password, displayName: username, exp: Date.now() + SESSION_MAX_AGE });
    var isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', 'mp=' + sid + '; Path=/; HttpOnly; SameSite=Strict' + (isSecure ? '; Secure' : ''));

    client.on('exists', function(data) {
      broadcast('imap:newMail', { path: data.path, count: data.count });
    });
    client.on('flags', function(data) {
      broadcast('imap:flagsChanged', { path: data.path, uid: data.uid, flags: Array.from(data.flags || []) });
    });
    client.on('close', function() {
      broadcast('imap:disconnected', {});
      imapClient = null;
    });
    client.on('error', function(err) {
      broadcast('imap:error', err.message);
    });
    broadcast('imap:connected', { user: mailUser, host: 'mail.nexusmail.cc' });
    res.json({ ok: true, user: mailUser });
  }).catch(function(e) {
    res.status(401).json({ error: 'Invalid username or password' });
  });
});

app.post('/api/logout', function(req, res) {
  var cookie = req.headers.cookie || '';
  var m = cookie.match(/mp=([^;]+)/);
  if (m) SESSIONS.delete(m[1]);
  if (imapClient) { try { imapClient.logout(); } catch(e) {} }
  imapClient = null; smtpTransport = null; config = null;
  broadcast('imap:disconnected', {});
  res.setHeader('Set-Cookie', 'mp=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
  res.json({ ok: true });
});

app.get('/api/check', function(req, res) {
  var s = checkAuth(req);
  res.json({ authenticated: !!s, user: s ? s.user : null, connected: !!imapClient });
});

// ── IMAP State ──
var imapClient = null;
var smtpTransport = null;
var config = null;
var wsClients = new Set();

// ── Lightweight polling via STATUS command (no mailbox open/close per folder) ──
var lastCounts = {};
setInterval(function() {
  if (!imapClient) return;
  imapClient.noop().catch(function() {});
  listFolders().then(function(folders) {
    var changed = [];
    for (var i = 0; i < folders.length; i++) {
      var f = folders[i];
      var key = f.path;
      var prev = lastCounts[key];
      if (prev !== undefined && f.total > prev) {
        changed.push(f.path);
      }
      lastCounts[key] = f.total;
    }
    if (changed.length > 0) {
      broadcast('imap:newMail', { paths: changed });
    }
  }).catch(function() {});
}, 15000);

function broadcast(type, data) {
  var msg = JSON.stringify({ type: type, data: data, ts: Date.now() });
  wsClients.forEach(function(ws) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch(e) { /* socket gone */ }
    }
  });
}

// ── Use STATUS command for fast folder listing (avoid opening each mailbox) ──
async function listFolders() {
  if (!imapClient) throw new Error('Not connected');
  var folders = [];
  var tree = await imapClient.listTree();
  function walk(node, depth) {
    if (!node || !node.folders) return;
    for (var i = 0; i < node.folders.length; i++) {
      var f = node.folders[i];
      folders.push({ name: f.name, path: f.path, delimiter: f.delimiter, specialUse: f.specialUse || null, depth: depth || 0, total: 0, unread: 0 });
      walk(f, (depth || 0) + 1);
    }
  }
  walk(tree, 0);

  // Fetch all statuses in parallel for speed
  var statusPromises = folders.map(function(f) {
    return imapClient.status(f.path, { messages: true, unseen: true }).then(function(st) {
      f.total = (st && st.messages) || 0;
      f.unread = (st && st.unseen) || 0;
    }).catch(function() {
      // Some folders (e.g. \Noselect) don't support STATUS
    });
  });
  await Promise.all(statusPromises);
  return folders;
}

async function listMessages(folderPath, page, limit) {
  if (!imapClient) throw new Error('Not connected');
  page = Number(page) || 1; limit = Number(limit) || 50;
  var mb = await imapClient.mailboxOpen(folderPath, { readOnly: true });
  var total = mb.exists;
  if (total === 0) { await imapClient.mailboxClose(); return { messages: [], total: 0, page: page, limit: limit }; }
  var start = Math.max(1, total - (page * limit) + 1);
  var end = Math.max(1, total - ((page - 1) * limit));
  var msgs = [];
  for await (var msg of imapClient.fetch(end + ':' + start, { envelope: true, flags: true, bodyStructure: true })) {
    msgs.push({
      id: msg.uid,
      from: (msg.envelope.from || []).map(function(a) { return a.address ? a.name + ' <' + a.address + '>' : (a.name || ''); }).join(', '),
      to: (msg.envelope.to || []).map(function(a) { return a.address ? a.name + ' <' + a.address + '>' : (a.name || ''); }).join(', '),
      subject: msg.envelope.subject || '(no subject)', date: msg.envelope.date,
      flags: Array.from(msg.flags || []), starred: !!(msg.flags && msg.flags.has('\\Flagged')),
      read: !(msg.flags && msg.flags.has('\\Seen')),
      hasAttachments: !!(msg.bodyStructure && JSON.stringify(msg.bodyStructure).includes('attachment')),
    });
  }
  await imapClient.mailboxClose();
  msgs.reverse();
  return { messages: msgs, total: total, page: page, limit: limit };
}

async function getMessage(folderPath, uid) {
  if (!imapClient) throw new Error('Not connected');
  await imapClient.mailboxOpen(folderPath, { readOnly: true });
  var msg = await imapClient.fetchOne(uid, { envelope: true, flags: true, source: true, bodyStructure: true }, { uid: true });
  var source = msg.source.toString();
  var textBody = '', htmlBody = '', attachments = [];
  var bm = source.match(/boundary="?([^"\r\n;]+)"?/);
  if (bm) {
    var parts = source.split('--' + bm[1]);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part.trim() || part.startsWith('--')) continue;
      var he = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
      if (he === -1) continue;
      var pH = part.substring(0, he);
      var pB = part.substring(he).replace(/^(\r?\n)+/, '').replace(/(\r?\n)?--$/, '');
      if (pH.includes('Content-Transfer-Encoding: base64')) {
        if (pH.includes('Content-Disposition: attachment') || pH.match(/filename[^;=\n]*=/)) {
          var fn = pH.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
          attachments.push({ name: fn ? fn[1].replace(/['"]/g, '') : 'attachment', size: pB.length });
          continue;
        }
        // Try to decode inline base64 content
        try {
          pB = Buffer.from(pB.replace(/\r?\n/g, ''), 'base64').toString('utf8');
        } catch(e) { /* leave as-is */ }
      }
      if (pH.includes('Content-Disposition: attachment') || pH.match(/filename[^;=\n]*=/)) {
        var fn = pH.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        attachments.push({ name: fn ? fn[1].replace(/['"]/g, '') : 'attachment', size: pB.length });
      } else if (pH.includes('text/html')) { htmlBody = pB; }
      else if (pH.includes('text/plain')) { textBody = pB; }
    }
  } else {
    var he = source.indexOf('\r\n\r\n') !== -1 ? source.indexOf('\r\n\r\n') : source.indexOf('\n\n');
    textBody = he !== -1 ? source.substring(he).replace(/^(\r?\n)+/, '') : source;
  }
  try { await imapClient.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch(e) {}
  await imapClient.mailboxClose();
  return {
    uid: msg.uid,
    from: (msg.envelope.from || []).map(function(a) { return a.address ? a.name + ' <' + a.address + '>' : (a.name || ''); }).join(', '),
    to: (msg.envelope.to || []).map(function(a) { return a.address ? a.name + ' <' + a.address + '>' : (a.name || ''); }).join(', '),
    cc: msg.envelope.cc ? msg.envelope.cc.map(function(a) { return a.address ? a.name + ' <' + a.address + '>' : (a.name || ''); }).join(', ') : '',
    subject: msg.envelope.subject || '(no subject)', date: msg.envelope.date,
    flags: Array.from(msg.flags || []), starred: !!(msg.flags && msg.flags.has('\\Flagged')),
    textBody: textBody.trim(), htmlBody: htmlBody.trim(), attachments: attachments,
  };
}

// ── Peek: fetch message body WITHOUT marking as seen (for notifications) ──
async function peekMessage(folderPath, uid) {
  if (!imapClient) throw new Error('Not connected');
  await imapClient.mailboxOpen(folderPath, { readOnly: true });
  var msg = await imapClient.fetchOne(uid, { envelope: true, source: true }, { uid: true });
  var source = msg.source.toString();
  var textBody = '', htmlBody = '';
  var bm = source.match(/boundary="?([^"\r\n;]+)"?/);
  if (bm) {
    var parts = source.split('--' + bm[1]);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part.trim() || part.startsWith('--')) continue;
      var he = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
      if (he === -1) continue;
      var pH = part.substring(0, he);
      var pB = part.substring(he).replace(/^(\r?\n)+/, '').replace(/(\r?\n)?--$/, '');
      if (pH.includes('Content-Disposition: attachment') || pH.match(/filename[^;=\n]*=/)) continue;
      if (pH.includes('Content-Transfer-Encoding: base64')) {
        try { pB = Buffer.from(pB.replace(/\r?\n/g, ''), 'base64').toString('utf8'); } catch(e) {}
      }
      if (pH.includes('text/html')) { htmlBody = pB; }
      else if (pH.includes('text/plain')) { textBody = pB; }
    }
  } else {
    var he = source.indexOf('\r\n\r\n') !== -1 ? source.indexOf('\r\n\r\n') : source.indexOf('\n\n');
    textBody = he !== -1 ? source.substring(he).replace(/^(\r?\n)+/, '') : source;
  }
  await imapClient.mailboxClose();
  return {
    uid: msg.uid,
    from: (msg.envelope.from || []).map(function(a) { return a.address ? a.name + ' <' + a.address + '>' : (a.name || ''); }).join(', '),
    to: (msg.envelope.to || []).map(function(a) { return a.address ? a.name + ' <' + a.address + '>' : (a.name || ''); }).join(', '),
    subject: msg.envelope.subject || '(no subject)',
    textBody: textBody.trim(),
    htmlBody: htmlBody.trim()
  };
}

async function toggleStar(fp, uid, starred) {
  if (!imapClient) throw new Error('Not connected');
  await imapClient.mailboxOpen(fp);
  starred ? await imapClient.messageFlagsAdd(uid, ['\\Flagged'], { uid: true }) : await imapClient.messageFlagsRemove(uid, ['\\Flagged'], { uid: true });
  await imapClient.mailboxClose();
  return { ok: true };
}

// Bug fix: added { uid: true } to messageFlagsAdd and iterate uids properly
async function deleteMessages(fp, uids) {
  if (!imapClient) throw new Error('Not connected');
  // If already in Trash, permanently delete
  if (fp === 'Trash' || fp === 'INBOX.Trash' || fp.endsWith('/Trash')) {
    await imapClient.mailboxOpen(fp);
    for (var i = 0; i < uids.length; i++) {
      await imapClient.messageDelete(uids[i], { uid: true });
    }
    await imapClient.mailboxClose();
    return { ok: true, permanent: true };
  }
  // Otherwise, move to Trash
  await imapClient.mailboxOpen(fp);
  for (var i = 0; i < uids.length; i++) {
    try {
      await imapClient.messageMove(uids[i], 'Trash', { uid: true });
    } catch (e) {
      // If Trash folder doesn't exist, fall back to permanent delete
      console.error('Move to Trash failed, deleting permanently:', e.message);
      await imapClient.messageDelete(uids[i], { uid: true });
    }
  }
  await imapClient.mailboxClose();
  return { ok: true, moved: true };
}


async function moveMessages(src, dest, uids) {
  if (!imapClient) throw new Error('Not connected');
  await imapClient.mailboxOpen(src);
  for (var i = 0; i < uids.length; i++) {
    await imapClient.messageMove(uids[i], dest, { uid: true });
  }
  await imapClient.mailboxClose();
  return { ok: true };
}
async function markMessagesRead(fp, uids) {
  if (!imapClient) throw new Error('Not connected');
  await imapClient.mailboxOpen(fp);
  for (var i = 0; i < uids.length; i++) {
    await imapClient.messageFlagsAdd(uids[i], ['\\Seen'], { uid: true });
  }
  await imapClient.mailboxClose();
  return { ok: true };
}

async function sendMail(opts) {
  if (!smtpTransport) throw new Error('SMTP not configured');
  var r = await smtpTransport.sendMail({
    from: config.displayName ? '"' + config.displayName + '" <' + config.imapUser + '>' : config.imapUser,
    to: opts.to, cc: opts.cc, bcc: opts.bcc, subject: opts.subject, text: opts.text, html: opts.html,
  });
  try {
    if (imapClient) {
      var msgContent = 'From: ' + (config.displayName ? config.displayName + ' <' + config.imapUser + '>' : config.imapUser) + '\r\n'
        + 'To: ' + (opts.to || '') + '\r\n'
        + (opts.cc ? 'Cc: ' + opts.cc + '\r\n' : '')
        + 'Subject: ' + (opts.subject || '') + '\r\n'
        + 'Date: ' + new Date().toUTCString() + '\r\n'
        + 'Message-ID: ' + r.messageId + '\r\n'
        + '\r\n'
        + (opts.text || '');
      await imapClient.append('Sent', msgContent, ['\\Seen']);
    }
  } catch(e) { console.error('Append to Sent failed:', e.message); }
  return { ok: true, messageId: r.messageId };
}

// ── API Routes ──
app.get('/api/status', requireAuth, function(req, res) { res.json({ connected: !!imapClient, user: config ? config.imapUser : null, host: config ? config.imapHost : null }); });
app.get('/api/folders', requireAuth, function(req, res) { listFolders().then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); }); });
app.get('/api/messages', requireAuth, function(req, res) { listMessages(req.query.folder, req.query.page, req.query.limit).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); }); });
app.get('/api/message', requireAuth, function(req, res) { getMessage(req.query.folder, Number(req.query.uid)).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); }); });
app.get('/api/peek', requireAuth, function(req, res) { peekMessage(req.query.folder, Number(req.query.uid)).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); }); });
app.post('/api/star', requireAuth, function(req, res) { toggleStar(req.body.folder, req.body.uid, req.body.starred).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); }); });
app.post('/api/delete', requireAuth, function(req, res) { deleteMessages(req.body.folder, req.body.uids).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); }); });
app.post('/api/markread', requireAuth, function(req, res) { markMessagesRead(req.body.folder, req.body.uids).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); }); });
app.post('/api/send', requireAuth, function(req, res) { sendMail(req.body).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); }); });


// ── Folder management ──
app.post('/api/folders/create', requireAuth, function(req, res) {
  if (!imapClient) return res.status(400).json({ error: 'Not connected' });
  var name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name required' });
  imapClient.mailboxCreate(name).then(function() {
    res.json({ ok: true, created: true });
  }).catch(function(e) {
    // If folder already exists, that's fine
    if (e.code === "ALREADYEXISTS" || (e.message && e.message.indexOf("already exists") >= 0)) {
      return res.json({ ok: true, existed: true });
    }
    res.status(400).json({ error: e.message });
  });
});

app.post('/api/folders/rename', requireAuth, function(req, res) {
  if (!imapClient) return res.status(400).json({ error: 'Not connected' });
  var oldPath = (req.body.oldPath || '').trim();
  var newPath = (req.body.newPath || '').trim();
  if (!oldPath || !newPath) return res.status(400).json({ error: 'Old and new path required' });
  imapClient.mailboxRename(oldPath, newPath).then(function() {
    res.json({ ok: true });
  }).catch(function(e) { res.status(400).json({ error: e.message }); });
});

app.post('/api/folders/delete', requireAuth, function(req, res) {
  if (!imapClient) return res.status(400).json({ error: 'Not connected' });
  var path = (req.body.path || '').trim();
  if (!path) return res.status(400).json({ error: 'Folder path required' });
  // Prevent deleting special folders
  var lower = path.toLowerCase();
  if (lower === 'inbox' || lower === 'trash' || lower === 'sent' || lower === 'drafts' || lower === 'junk' || lower === 'spam') {
    return res.status(400).json({ error: 'Cannot delete system folder' });
  }
  imapClient.mailboxDelete(path).then(function() {
    res.json({ ok: true });
  }).catch(function(e) { res.status(400).json({ error: e.message }); });
});

// ── Move messages to folder ──
app.post('/api/move', requireAuth, function(req, res) {
  if (!imapClient) return res.status(400).json({ error: 'Not connected' });
  var src = req.body.folder;
  var dest = req.body.dest;
  var uids = req.body.uids;
  if (!src || !dest || !uids || !uids.length) return res.status(400).json({ error: 'folder, dest, and uids required' });
  moveMessages(src, dest, uids).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); });
});

wss.on('connection', function(ws) {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'status', data: { connected: !!imapClient, user: config ? config.imapUser : null, host: config ? config.imapHost : null }}));
  ws.on('close', function() { wsClients.delete(ws); });
  ws.on('error', function() { wsClients.delete(ws); });
});

var PORT = process.env.PORT || 3456;
server.listen(PORT, '127.0.0.1', function() { console.log('Mail Panel running on http://localhost:' + PORT); });
