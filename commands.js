'use strict';

const {
  parseResults,
  resultKey,
  formatMessage,
} = require('./portal');

const MAX_MSG_LEN = 4000;

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.substring(0, max - 20) + '\n\n_(truncated)_';
}

function statusEmoji(status) {
  const s = (status || '').toUpperCase();
  if (s.includes('NOT') && s.includes('PAID')) return '\u{1F534}';
  if (s.includes('PAID') || s.includes('TO BE PAID')) return '\u{1F7E2}';
  return '\u26AA';
}

function buildHelp() {
  return (
    '\u{1F4CB} *mysmsportal WhatsApp Bot*\n\n' +
    '*Commands:*\n' +
    '/help — Show this help\n' +
    '/results — Latest test results\n' +
    '/rates <country> — Search rate card\n' +
    '/numbers — Your allocated numbers\n' +
    '/clients — List sub-accounts\n' +
    '/payouts — Current payouts (top 30)\n' +
    '/today — Today summary\n' +
    '/todaydetail — Today detail by range\n' +
    '/summaries — Sender summaries\n' +
    '/statements — Recent statements\n' +
    '/pair <phone> — Pair new WhatsApp number\n' +
    '/login <user> <pass> — Change portal login\n' +
    '/status — Bot status'
  );
}

async function handleResults(portal) {
  const html = await portal.fetchResultsPage();
  const rows = parseResults(html);
  if (rows.length === 0) return '\u26A0\uFE0F No test results found.';
  const latest = rows.slice(-10);
  let msg = `\u{1F4CA} *Latest ${latest.length} test results:*\n\n`;
  for (const r of latest.reverse()) {
    msg += `${statusEmoji(r.status)} ${r.date}\n${r.termination} | ${r.ddi}\nCLI: ${r.cli} | *${r.status}*\n\n`;
  }
  return truncate(msg.trim(), MAX_MSG_LEN);
}

async function handleRates(portal, query) {
  if (!query) return '\u26A0\uFE0F Usage: /rates <country>\nExample: /rates georgia';
  const rates = await portal.fetchRateCard();
  const q = query.toLowerCase();
  const matches = rates.filter(r => r.termination.toLowerCase().includes(q));
  if (matches.length === 0) return `\u{1F50D} No rates found for "${query}".`;
  const top = matches.slice(0, 20);
  let msg = `\u{1F4B1} *Rates matching "${query}" (${matches.length} found, showing ${top.length}):*\n\n`;
  for (const r of top) {
    msg += `*${r.termination}*\n`;
    msg += `Monthly: ${r.monthlyRate} ${r.currency} | Weekly: ${r.weeklyRate} ${r.currency}\n`;
    msg += `Terms: ${r.terms} | ${r.note}\n\n`;
  }
  return truncate(msg.trim(), MAX_MSG_LEN);
}

async function handleNumbers(portal) {
  const numbers = await portal.fetchAllocatedNumbers();
  if (numbers.length === 0) return '\u26A0\uFE0F No allocated numbers found.';
  let msg = `\u{1F4F1} *Allocated Numbers (${numbers.length}):*\n\n`;
  for (const n of numbers) {
    msg += `${n.range} — ${n.country}\n`;
  }
  return truncate(msg.trim(), MAX_MSG_LEN);
}

async function handleClients(portal) {
  const clients = await portal.fetchClients();
  if (clients.length === 0) return '\u26A0\uFE0F No clients found.';
  let msg = `\u{1F465} *Clients (${clients.length}):*\n\n`;
  msg += '*ID | Name | Password*\n';
  for (const c of clients) {
    msg += `${c.id} | ${c.name} | ${c.password}\n`;
  }
  return truncate(msg.trim(), MAX_MSG_LEN);
}

async function handlePayouts(portal) {
  const rows = await portal.fetchPayouts();
  if (rows.length === 0) return '\u26A0\uFE0F No payouts found.';

  let totalPaid = 0;
  let totalUnpaid = 0;
  let totalMessages = 0;
  for (const r of rows) {
    const msgs = parseInt(r.messages, 10) || 0;
    totalMessages += msgs;
    const upper = r.status.toUpperCase();
    if (upper.includes('NOT') && upper.includes('PAID')) totalUnpaid += msgs;
    else if (upper.includes('TO BE PAID')) totalPaid += msgs;
    else totalUnpaid += msgs;
  }

  const top = rows.slice(0, 30);
  let msg = `\u{1F4B0} *Payouts (${rows.length} entries):*\n`;
  msg += `Total msgs: ${totalMessages} | Paid: ${totalPaid} | Not paid: ${totalUnpaid}\n\n`;
  msg += '*Top 30:*\n';
  for (const r of top) {
    msg += `${statusEmoji(r.status)} ${r.number} (${r.sender})\n`;
    msg += `${r.messages} msgs | ${r.range} | ${r.rate} ${r.currency}\n\n`;
  }
  return truncate(msg.trim(), MAX_MSG_LEN);
}

async function handleToday(portal) {
  const summary = await portal.fetchTodaySummary();
  let msg = '\u{1F4C5} *Today Summary:*\n\n';

  if (summary.statusSummary.length > 0) {
    msg += '*Status Overview:*\n';
    for (const s of summary.statusSummary) {
      msg += `${statusEmoji(s.status)} ${s.status}: ${s.messages} msgs\n`;
    }
    msg += '\n';
  }

  if (summary.rangeSummary.length > 0) {
    msg += '*By Range:*\n';
    for (const r of summary.rangeSummary) {
      msg += `${statusEmoji(r.status)} ${r.range} — ${r.status}: ${r.messages}\n`;
    }
  }

  return truncate(msg.trim(), MAX_MSG_LEN);
}

async function handleTodayDetail(portal) {
  const rows = await portal.fetchTodaySoFar();
  if (rows.length === 0) return '\u26A0\uFE0F No data for today.';

  const rangeMap = {};
  for (const r of rows) {
    const key = r.range || 'Unknown';
    if (!rangeMap[key]) rangeMap[key] = { paid: 0, unpaid: 0, total: 0 };
    const msgs = parseInt(r.messages, 10) || 0;
    rangeMap[key].total += msgs;
    const upper = (r.status || '').toUpperCase();
    if (upper.includes('NOT') && upper.includes('PAID')) rangeMap[key].unpaid += msgs;
    else if (upper.includes('TO BE PAID')) rangeMap[key].paid += msgs;
    else rangeMap[key].unpaid += msgs;
  }

  const sorted = Object.entries(rangeMap).sort((a, b) => b[1].total - a[1].total);
  let msg = `\u{1F4CA} *Today Detail (${rows.length} entries):*\n\n`;
  for (const [range, data] of sorted.slice(0, 25)) {
    msg += `*${range}*\n`;
    msg += `Total: ${data.total} | \u{1F7E2} Paid: ${data.paid} | \u{1F534} Not paid: ${data.unpaid}\n\n`;
  }
  return truncate(msg.trim(), MAX_MSG_LEN);
}

async function handleSummaries(portal) {
  const senders = await portal.fetchSenderSummaries();
  if (senders.length === 0) return '\u26A0\uFE0F No sender summaries found.';
  let msg = `\u{1F4E8} *Sender Summaries (${senders.length}):*\n\n`;
  msg += '*Sender | Messages*\n';
  for (const s of senders) {
    msg += `${s.sender} — ${s.messages} msgs\n`;
  }
  return truncate(msg.trim(), MAX_MSG_LEN);
}

async function handleStatements(portal) {
  const statements = await portal.fetchStatements();
  if (statements.length === 0) return '\u26A0\uFE0F No statements found.';
  const top = statements.slice(0, 15);
  let msg = `\u{1F4C4} *Statements (${statements.length} total, showing ${top.length}):*\n\n`;
  for (const s of top) {
    const emoji = s.status.toUpperCase() === 'PAID' ? '\u{1F7E2}' : '\u{1F534}';
    msg += `${emoji} *Ref ${s.reference}*\n`;
    msg += `${s.dateFrom} — ${s.dateTo}\n`;
    msg += `Payout: ${s.payout} ${s.currency} | ${s.status}\n`;
    msg += `Due: ${s.due} | Terms: ${s.terms}\n\n`;
  }
  return truncate(msg.trim(), MAX_MSG_LEN);
}

function handleStatus(startTime, pollInterval) {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = uptime % 60;
  return (
    `\u{1F916} *Bot Status*\n` +
    `Uptime: ${hours}h ${minutes}m ${seconds}s\n` +
    `Poll interval: ${pollInterval / 1000}s\n` +
    `Running since: ${new Date(startTime).toISOString()}`
  );
}

module.exports = {
  buildHelp,
  handleResults,
  handleRates,
  handleNumbers,
  handleClients,
  handlePayouts,
  handleToday,
  handleTodayDetail,
  handleSummaries,
  handleStatements,
  handleStatus,
};
