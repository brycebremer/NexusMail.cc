const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join(__dirname, 'rules.json');

function loadRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveRules(rules) {
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
}

function matchRule(rule, msg) {
  if (!rule.enabled) return false;
  var cond = rule.conditions || {};

  // Check sender (from)
  if (cond.from) {
    var from = (msg.from || '').toLowerCase();
    var patterns = cond.from.toLowerCase().split(',').map(function(s) { return s.trim(); });
    var match = patterns.some(function(p) { return from.indexOf(p) >= 0; });
    if (!match) return false;
  }

  // Check recipient (to)
  if (cond.to) {
    var to = (msg.to || '').toLowerCase();
    var patterns = cond.to.toLowerCase().split(',').map(function(s) { return s.trim(); });
    var match = patterns.some(function(p) { return to.indexOf(p) >= 0; });
    if (!match) return false;
  }

  // Check subject
  if (cond.subject) {
    var subject = (msg.subject || '').toLowerCase();
    var patterns = cond.subject.toLowerCase().split(',').map(function(s) { return s.trim(); });
    var match = patterns.some(function(p) { return subject.indexOf(p) >= 0; });
    if (!match) return false;
  }

  // Check attachment type
  if (cond.attachment) {
    var hasAttach = msg.hasAttachments || (msg.bodyStructure && JSON.stringify(msg.bodyStructure).includes(cond.attachment.toLowerCase()));
    if (!hasAttach) return false;
  }

  // Check time range
  if (cond.timeAfter || cond.timeBefore) {
    var msgDate = new Date(msg.envelope ? msg.envelope.date : msg.date);
    var minutes = msgDate.getHours() * 60 + msgDate.getMinutes();
    if (cond.timeAfter) {
      var parts = cond.timeAfter.split(':');
      var afterMin = parseInt(parts[0]) * 60 + parseInt(parts[1] || 0);
      if (minutes < afterMin) return false;
    }
    if (cond.timeBefore) {
      var parts = cond.timeBefore.split(':');
      var beforeMin = parseInt(parts[0]) * 60 + parseInt(parts[1] || 0);
      if (minutes >= beforeMin) return false;
    }
  }

  return true;
}

// Apply rules to a list of messages in a folder
async function applyRules(imap, folder, messages) {
  var rules = loadRules();
  var applied = [];
  for (var r = 0; r < rules.length; r++) {
    var rule = rules[r];
    if (!rule.enabled) continue;
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      if (matchRule(rule, msg)) {
        try {
          if (rule.action === 'move' && rule.dest && rule.dest !== folder) {
            await imap.messageMove(msg.uid, rule.dest, { uid: true });
            applied.push({ rule: rule.name, uid: msg.uid, dest: rule.dest });
          } else if (rule.action === 'delete') {
            await imap.messageDelete(msg.uid, { uid: true });
            applied.push({ rule: rule.name, uid: msg.uid, action: 'deleted' });
          } else if (rule.action === 'markread') {
            await imap.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
            applied.push({ rule: rule.name, uid: msg.uid, action: 'marked read' });
          }
        } catch (e) {
          console.error('Rule apply error:', rule.name, e.message);
        }
      }
    }
  }
  return applied;
}

// Process rules for specific new UIDs (real-time, called from IMAP exists event)
async function processRulesForUids(imap, folder, uids) {
  if (!imap || !uids || !uids.length) return [];
  var rules = loadRules();
  var enabled = rules.filter(function(r) { return r.enabled; });
  if (!enabled.length) return [];
  try {
    var wasOpen = imap.mailbox && imap.mailbox.path === folder;
    if (!wasOpen) await imap.mailboxOpen(folder, { readOnly: false });
    var uidList = uids.join(',');
    var messages = [];
    for await (var msg of imap.fetch(uidList, { envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
      messages.push(msg);
    }
    var applied = await applyRules(imap, folder, messages);
    if (!wasOpen) { try { await imap.mailboxClose(); } catch(e2) {} }
    if (applied.length) console.log('[Rules] Real-time applied', applied.length, 'rule(s) in', folder);
    return applied;
  } catch (e) {
    console.error('processRulesForUids error:', e.message);
    try { await imap.mailboxClose(); } catch(e2) {}
    return [];
  }
}

// Fetch recent messages and apply rules (fallback / manual "Run Rules Now")
async function processRulesForFolder(imap, folder, limit) {
  if (!imap) return [];
  var rules = loadRules();
  if (!rules.length) return [];
  try {
    await imap.mailboxOpen(folder, { readOnly: false });
    var mb = imap.mailbox;
    if (!mb || !mb.exists) { await imap.mailboxClose(); return []; }
    var total = mb.exists;
    var start = Math.max(1, total - (limit || 5) + 1);
    var messages = [];
    for await (var msg of imap.fetch(total + ':' + start, { envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
      messages.push(msg);
    }
    var applied = await applyRules(imap, folder, messages);
    await imap.mailboxClose();
    return applied;
  } catch (e) {
    console.error('processRules error:', e.message);
    try { await imap.mailboxClose(); } catch(e2) {}
    return [];
  }
}

module.exports = { loadRules, saveRules, matchRule, applyRules, processRulesForFolder, processRulesForUids };
