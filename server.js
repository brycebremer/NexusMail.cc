const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { loadRules, saveRules, matchRule, applyRules, processRulesForFolder, processRulesForUids } = require('./rules-engine');
const nodemailer = require('nodemailer');
const path = require('path');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB max

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Session store with automatic cleanup ──
const SESSIONS = new Map();
const SESSION_MAX_AGE = 86400000; // 24h (remember me)
const SESSION_SHORT_AGE = 1800000; // 30 min (no remember)

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
    SESSIONS.set(sid, { user: mailUser, pass: password, displayName: username, exp: Date.now() + (req.body.remember ? SESSION_MAX_AGE : SESSION_SHORT_AGE) });
    var isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', 'mp=' + sid + '; Path=/; HttpOnly; SameSite=Strict' + (isSecure ? '; Secure' : ''));

    client.on('exists', function(data) {
      broadcast('imap:newMail', { path: data.path, count: data.count });
      // Real-time rules: fetch new message UIDs and process immediately
      if (data.path && data.count) {
        (async function() {
          try {
            var mb = await client.mailboxOpen(data.path, { readOnly: false });
            if (mb && mb.exists) {
              // Fetch UIDs of the newest messages (last 3 to catch batch arrivals)
              var start = Math.max(1, mb.exists - 2);
              var newUids = [];
              for await (var msg of client.fetch(mb.exists + ':' + start, ['uid'])) {
                newUids.push(msg.uid);
              }
              await client.mailboxClose();
              if (newUids.length) {
                processRulesForUids(data.path, newUids).catch(function(e) {
                  console.error('[Rules] Real-time error:', e.message);
                });
              }
            }
          } catch(e) {
            console.error('[Rules] Exists handler error:', e.message);
            try { await client.mailboxClose(); } catch(e2) {}
          }
        })();
      }
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

// ── Contacts Index (built from seen envelope addresses) ──
var contactsMap = new Map(); // email(lower) → { email, name, lastSeen }

function indexAddresses(envelope) {
  var addrs = [].concat(envelope.from || [], envelope.to || [], envelope.cc || [], envelope.bcc || []);
  var now = Date.now();
  for (var i = 0; i < addrs.length; i++) {
    var a = addrs[i];
    if (!a || !a.address) continue;
    var email = a.address.toLowerCase();
    // Skip the logged-in user's own address
    if (config && email === config.imapUser.toLowerCase()) continue;
    var existing = contactsMap.get(email);
    if (!existing || (a.name && a.name.length > (existing.name || '').length)) {
      contactsMap.set(email, { email: email, name: (a.name || '').trim(), lastSeen: now });
    } else if (existing) {
      existing.lastSeen = now;
    }
  }
}

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
      // Rules are now processed in real-time via IMAP exists event
      // Fallback: process rules via poll only if exists event may have been missed
      for (var i = 0; i < changed.length; i++) {
        processRulesForFolder(changed[i], 3).catch(function() {});
      }
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
    indexAddresses(msg.envelope);
    msgs.push({
      id: msg.uid,
      from: (msg.envelope.from || []).map(function(a) { return a.address ? a.name + ' <' + a.address + '>' : (a.name || ''); }).join(', '),
      to: (msg.envelope.to || []).map(function(a) { return a.address ? a.name + ' <' + a.address + '>' : (a.name || ''); }).join(', '),
      subject: msg.envelope.subject || '(no subject)', date: msg.envelope.date,
      flags: Array.from(msg.flags || []), starred: !!(msg.flags && msg.flags.has('\\Flagged')),
      read: !!(msg.flags && msg.flags.has('\\Seen')),
      hasAttachments: !!(msg.bodyStructure && JSON.stringify(msg.bodyStructure).includes('attachment')),
    });
  }
  await imapClient.mailboxClose();
  msgs.reverse();
  return { messages: msgs, total: total, page: page, limit: limit };
}

async function getMessage(folderPath, uid) {
  if (!imapClient) throw new Error('Not connected');
  await imapClient.mailboxOpen(folderPath, { readOnly: false });
  var msg = await imapClient.fetchOne(uid, { envelope: true, flags: true, source: true, bodyStructure: true }, { uid: true });
  indexAddresses(msg.envelope);
  // Use mailparser for proper MIME decoding (handles base64, quoted-printable, multipart, etc.)
  var parsed = await simpleParser(msg.source);
  var textBody = parsed.text || '';
  var htmlBody = parsed.html || '';
  var attachments = [];
  if (parsed.attachments && parsed.attachments.length) {
    for (var i = 0; i < parsed.attachments.length; i++) {
      var att = parsed.attachments[i];
      attachments.push({ name: att.filename || 'attachment', size: att.size, contentType: att.contentType });
    }
  }
  try { await imapClient.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); broadcast('imap:flagsChanged', { path: folderPath, uid: uid, flags: ['\\Seen'] }); } catch(e) {}
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
  indexAddresses(msg.envelope);
  var parsed = await simpleParser(msg.source);
  await imapClient.mailboxClose();
  return {
    uid: msg.uid,
    from: (msg.envelope.from || []).map(function(a) { return a.address ? a.name + ' <' + a.address + '>' : (a.name || ''); }).join(', '),
    to: (msg.envelope.to || []).map(function(a) { return a.address ? a.name + ' <' + a.address + '>' : (a.name || ''); }).join(', '),
    subject: msg.envelope.subject || '(no subject)',
    textBody: (parsed.text || '').trim(),
    htmlBody: (parsed.html || '').trim()
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
async function searchMessages(folder, query) {
  if (!imapClient) throw new Error('Not connected');
  await imapClient.mailboxOpen(folder, { readOnly: true });
  var uids = await imapClient.search({
    or: [
      { from: query },
      { or: [
        { subject: query },
        { or: [
          { to: query },
          { body: query }
        ]}
      ]}
    ]
  }, { uid: true });
  var total = uids ? uids.length : 0;
  var msgs = [];
  if (uids && uids.length > 0) {
    // Fetch envelopes for up to 80 results (most recent first)
    var fetchUids = uids.slice(-80).reverse();
    for await (var msg of imapClient.fetch(fetchUids.join(','), { envelope: true, flags: true }, { uid: true })) {
      msgs.push({
        id: msg.uid,
        from: (msg.envelope.from || []).map(function(a) { return a.address ? a.name + ' <' + a.address + '>' : (a.name || ''); }).join(', '),
        to: (msg.envelope.to || []).map(function(a) { return a.address ? a.name + ' <' + a.address + '>' : (a.name || ''); }).join(', '),
        subject: msg.envelope.subject || '(no subject)', date: msg.envelope.date,
        flags: Array.from(msg.flags || []), starred: !!(msg.flags && msg.flags.has('\\Flagged')),
        read: !!(msg.flags && msg.flags.has('\\Seen')),
        hasAttachments: false
      });
    }
    msgs.reverse();
  }
  await imapClient.mailboxClose();
  return { messages: msgs, total: total, folder: folder, query: query };
}

async function emptyTrash() {
  if (!imapClient) throw new Error('Not connected');
  var mb = await imapClient.mailboxOpen('Trash');
  var total = mb.exists || 0;
  if (total === 0) { await imapClient.mailboxClose(); return { ok: true, deleted: 0 }; }
  // Delete all messages (1:* in UID mode)
  await imapClient.messageDelete('1:*', { uid: true });
  await imapClient.mailboxClose();
  return { ok: true, deleted: total };
}

async function markMessagesRead(fp, uids) {
  if (!imapClient) throw new Error('Not connected');
  await imapClient.mailboxOpen(fp);
  for (var i = 0; i < uids.length; i++) {
    await imapClient.messageFlagsAdd(uids[i], ['\\Seen'], { uid: true });
  }
  broadcast('imap:flagsChanged', { path: fp, uids: uids });
  await imapClient.mailboxClose();
  return { ok: true };
}

async function sendMail(opts) {
  if (!smtpTransport) throw new Error('SMTP not configured');
  var mailOpts = {
    from: config.displayName ? '"' + config.displayName + '" <' + config.imapUser + '>' : config.imapUser,
    to: opts.to, cc: opts.cc, bcc: opts.bcc, subject: opts.subject, text: opts.text, html: opts.html,
  };
  if (opts.attachments && opts.attachments.length) mailOpts.attachments = opts.attachments;
  var r = await smtpTransport.sendMail(mailOpts);
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

// ── Attachment download ──
app.get('/api/attachment', requireAuth, function(req, res) {
  if (!imapClient) return res.status(400).json({ error: 'Not connected' });
  var folder = req.query.folder;
  var uid = Number(req.query.uid);
  var index = Number(req.query.index);
  if (!folder || (!uid && uid !== 0)) return res.status(400).json({ error: 'folder and uid required' });
  (async function() {
    await imapClient.mailboxOpen(folder, { readOnly: true });
    var msg = await imapClient.fetchOne(uid, { source: true }, { uid: true });
    var parsed = await simpleParser(msg.source);
    await imapClient.mailboxClose();
    if (!parsed.attachments || !parsed.attachments[index]) return res.status(404).json({ error: 'Attachment not found' });
    var att = parsed.attachments[index];
    var filename = att.filename || 'attachment';
    res.setHeader('Content-Type', att.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename.replace(/"/g, '\\"') + '"');
    res.setHeader('Content-Length', att.size);
    res.send(att.content);
  })().catch(function(e) { res.status(400).json({ error: e.message }); });
});

// ── Send with attachments ──
app.post('/api/send', requireAuth, upload.array('attachments', 10), function(req, res) {
  var opts = {
    to: req.body.to, cc: req.body.cc, bcc: req.body.bcc,
    subject: req.body.subject, text: req.body.text, html: req.body.html
  };
  if (req.files && req.files.length) {
    opts.attachments = req.files.map(function(f) {
      return { filename: f.originalname, content: f.buffer, contentType: f.mimetype };
    });
  }
  sendMail(opts).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); });
});
app.get('/api/peek', requireAuth, function(req, res) { peekMessage(req.query.folder, Number(req.query.uid)).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); }); });
app.post('/api/star', requireAuth, function(req, res) { toggleStar(req.body.folder, req.body.uid, req.body.starred).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); }); });
app.post('/api/delete', requireAuth, function(req, res) { deleteMessages(req.body.folder, req.body.uids).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); }); });
app.post('/api/markread', requireAuth, function(req, res) { markMessagesRead(req.body.folder, req.body.uids).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); }); });

// ── Drafts ──
app.post('/api/drafts/save', requireAuth, function(req, res) {
  if (!imapClient) return res.status(400).json({ error: 'Not connected' });
  var to = req.body.to || '';
  var cc = req.body.cc || '';
  var subject = req.body.subject || '';
  var text = req.body.text || '';
  var html = req.body.html || '';
  var draftUid = req.body.draftUid; // if editing existing draft
  var from = config.imapUser;
  // Build MIME message
  var lines = [];
  lines.push('From: ' + from);
  if (to) lines.push('To: ' + to);
  if (cc) lines.push('Cc: ' + cc);
  lines.push('Subject: ' + subject);
  lines.push('Date: ' + new Date().toUTCString());
  lines.push('X-Draft: yes');
  if (html) {
    var boundary = '----=_Part_' + Date.now();
    lines.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    lines.push('MIME-Version: 1.0');
    lines.push('');
    lines.push('--' + boundary);
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(text);
    lines.push('--' + boundary);
    lines.push('Content-Type: text/html; charset=utf-8');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(html);
    lines.push('--' + boundary + '--');
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('');
    lines.push(text);
  }
  var msgContent = lines.join('\r\n');
  // Delete old draft if editing
  var deletePromise = Promise.resolve();
  if (draftUid) {
    deletePromise = imapClient.messageDelete(draftUid, { uid: true }).catch(function() {});
  }
  deletePromise.then(function() {
    return imapClient.append('Drafts', msgContent, ['\\Draft', '\\Seen']);
  }).then(function(ret) {
    res.json({ ok: true, uid: ret && ret.uid });
  }).catch(function(e) { res.status(400).json({ error: e.message }); });
});
// Old /api/send replaced by multer version above


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
// ── Search messages ──
app.get('/api/search', requireAuth, function(req, res) {
  if (!imapClient) return res.status(400).json({ error: 'Not connected' });
  var q = (req.query.q || '').trim();
  var folder = req.query.folder || 'INBOX';
  if (!q) return res.json({ messages: [], total: 0 });
  searchMessages(folder, q).then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); });
});

// ── Contacts Autocomplete ──
app.get('/api/contacts', requireAuth, function(req, res) {
  var q = (req.query.q || '').trim().toLowerCase();
  if (!q) { res.json([]); return; }
  var results = [];
  contactsMap.forEach(function(c) {
    if (c.email.indexOf(q) >= 0 || c.name.toLowerCase().indexOf(q) >= 0) {
      results.push(c);
    }
  });
  results.sort(function(a, b) { return b.lastSeen - a.lastSeen; });
  res.json(results.slice(0, 10));
});

// ── Rules ──
app.get('/api/rules', requireAuth, function(req, res) {
  res.json(loadRules());
});

app.post('/api/rules', requireAuth, function(req, res) {
  var rules = loadRules();
  var rule = req.body;
  if (!rule || !rule.name) return res.status(400).json({ error: 'Rule name required' });
  rule.id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  rule.enabled = rule.enabled !== false;
  rule.conditions = rule.conditions || {};
  rule.action = rule.action || 'move';
  if (rule.action === 'move' && !rule.dest) return res.status(400).json({ error: 'Destination folder required for move action' });
  rules.push(rule);
  saveRules(rules);
  res.json({ ok: true, rule: rule });
});

app.put('/api/rules/:id', requireAuth, function(req, res) {
  var rules = loadRules();
  var id = req.params.id;
  var idx = -1;
  for (var i = 0; i < rules.length; i++) { if (rules[i].id === id) { idx = i; break; } }
  if (idx === -1) return res.status(404).json({ error: 'Rule not found' });
  var updated = req.body;
  updated.id = id;
  updated.conditions = updated.conditions || {};
  updated.action = updated.action || 'move';
  rules[idx] = updated;
  saveRules(rules);
  res.json({ ok: true, rule: updated });
});

app.delete('/api/rules/:id', requireAuth, function(req, res) {
  var rules = loadRules();
  var id = req.params.id;
  rules = rules.filter(function(r) { return r.id !== id; });
  saveRules(rules);
  res.json({ ok: true });
});

app.post('/api/rules/apply', requireAuth, function(req, res) {
  var folder = req.body.folder || 'INBOX';
  processRulesForFolder(folder, 20).then(function(applied) {
    res.json({ ok: true, applied: applied });
  }).catch(function(e) { res.status(400).json({ error: e.message }); });
});

// ── Empty Trash ──
app.post('/api/emptytrash', requireAuth, function(req, res) {
  if (!imapClient) return res.status(400).json({ error: 'Not connected' });
  emptyTrash().then(function(r) { res.json(r); }).catch(function(e) { res.status(400).json({ error: e.message }); });
});

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
