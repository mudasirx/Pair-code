'use strict';

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');

const BASE_URL = 'http://mysmsportal.com';
const LOGIN_URL = `${BASE_URL}/index.php?login=1`;
const UA = 'Mozilla/5.0 (compatible; mysmsportal-bot/1.0)';

function buildCookieHeader(jar, url) {
  return new Promise((resolve, reject) => {
    jar.getCookieString(url, (err, str) => (err ? reject(err) : resolve(str || '')));
  });
}

function storeSetCookie(jar, url, setCookieHeader) {
  if (!setCookieHeader) return Promise.resolve();
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return Promise.all(
    cookies.map(
      (c) => new Promise((resolve, reject) => jar.setCookie(c, url, (e) => (e ? reject(e) : resolve())))
    )
  );
}

async function request(jar, method, url, options = {}) {
  const cookieHeader = await buildCookieHeader(jar, url);
  const headers = {
    'User-Agent': UA,
    Cookie: cookieHeader,
    ...(options.headers || {}),
  };
  const resp = await axios({
    method,
    url,
    headers,
    data: options.data,
    timeout: options.timeout || 30000,
    maxRedirects: 5,
    validateStatus: () => true,
  });
  await storeSetCookie(jar, url, resp.headers['set-cookie']);
  return resp;
}

class PortalClient {
  constructor(username, password, logger) {
    this.username = username;
    this.password = password;
    this.log = logger || console;
    this.jar = new CookieJar();
  }

  async login() {
    this.log.info('Logging into mysmsportal.com');
    this.jar = new CookieJar();
    await request(this.jar, 'GET', BASE_URL);
    const body = new URLSearchParams({ user: this.username, password: this.password }).toString();
    const resp = await request(this.jar, 'POST', LOGIN_URL, {
      data: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (resp.status >= 400) {
      throw new Error(`Login HTTP ${resp.status}`);
    }
    if (!/logout=1|Signoff/i.test(resp.data || '')) {
      throw new Error('Login failed: no logout link in response');
    }
    this.log.info('Portal login successful');
  }

  async fetchPage(url) {
    let resp = await request(this.jar, 'GET', url);
    if (resp.status >= 400) throw new Error(`Fetch HTTP ${resp.status}`);
    if (/Please enter your login details/i.test(resp.data || '')) {
      this.log.warn('Session expired, re-logging in');
      await this.login();
      resp = await request(this.jar, 'GET', url);
      if (resp.status >= 400) throw new Error(`Fetch after re-login HTTP ${resp.status}`);
    }
    return resp.data;
  }

  async fetchResultsPage() {
    return this.fetchPage(`${BASE_URL}/index.php?opt=shw_test_np`);
  }

  async fetchRateCard() {
    const html = await this.fetchPage(`${BASE_URL}/index.php?opt=shw_ratecardf`);
    return parseRateCard(html);
  }

  async fetchAllocatedNumbers() {
    const html = await this.fetchPage(`${BASE_URL}/index.php`);
    return parseAllocatedNumbers(html);
  }

  async fetchClients() {
    const html = await this.fetchPage(`${BASE_URL}/index.php?opt=shw_mge`);
    return parseClients(html);
  }

  async fetchPayouts() {
    const html = await this.fetchPage(`${BASE_URL}/index.php?opt=shw_sts_today_v2`);
    return parsePayouts(html);
  }

  async fetchTodaySoFar() {
    const html = await this.fetchPage(`${BASE_URL}/index.php?opt=shw_sts_today`);
    return parseTodaySoFar(html);
  }

  async fetchTodaySummary() {
    const html = await this.fetchPage(`${BASE_URL}/index.php?opt=shw_sts_today_sum`);
    return parseTodaySummary(html);
  }

  async fetchSenderSummaries() {
    const html = await this.fetchPage(`${BASE_URL}/index.php?opt=shw_sum`);
    return parseSenderSummaries(html);
  }

  async fetchStatements() {
    const html = await this.fetchPage(`${BASE_URL}/index.php?opt=shw_sta`);
    return parseStatements(html);
  }
}

// --- Parsers ---

function parseResults(html) {
  const $ = cheerio.load(html);
  const results = [];
  $('table').each((_, table) => {
    const headers = $(table)
      .find('th')
      .map((__, th) => $(th).text().trim())
      .get();
    if (!(headers.includes('Date') && headers.includes('STATUS') && headers.includes('DDI'))) return;
    $(table)
      .find('tr')
      .each((__, tr) => {
        const cells = $(tr)
          .find('td')
          .map((___, td) => $(td).text().trim())
          .get();
        if (cells.length < 5) return;
        results.push({
          date: cells[0],
          termination: cells[1],
          ddi: cells[2],
          cli: cells[3],
          status: cells[4],
        });
      });
  });
  return results;
}

function parseRateCard(html) {
  const $ = cheerio.load(html);
  const rates = [];
  $('table').each((_, table) => {
    const headers = $(table).find('th').map((__, th) => $(th).text().trim().toUpperCase()).get();
    if (!headers.includes('TERMINATION') || !headers.includes('CURRENCY')) return;
    $(table).find('tr').each((__, tr) => {
      const cells = $(tr).find('td').map((___, td) => $(td).text().trim()).get();
      if (cells.length < 6) return;
      rates.push({
        termination: cells[0],
        currency: cells[1],
        monthlyRate: cells[2],
        weeklyRate: cells[3],
        terms: cells[4],
        note: cells[5],
      });
    });
  });
  return rates;
}

function parseAllocatedNumbers(html) {
  const $ = cheerio.load(html);
  const numbers = [];
  $('table').each((_, table) => {
    const headers = $(table).find('th').map((__, th) => $(th).text().trim().toUpperCase()).get();
    if (!headers.includes('RANGE') || !headers.includes('COUNTRY')) return;
    $(table).find('tr').each((__, tr) => {
      const cells = $(tr).find('td').map((___, td) => $(td).text().trim()).get();
      if (cells.length < 2) return;
      numbers.push({ range: cells[0], country: cells[1] });
    });
  });
  return numbers;
}

function parseClients(html) {
  const $ = cheerio.load(html);
  const clients = [];
  $('table').each((_, table) => {
    const headers = $(table).find('th').map((__, th) => $(th).text().trim().toUpperCase()).get();
    if (!headers.includes('ID') || !headers.includes('NAME')) return;
    $(table).find('tr').each((__, tr) => {
      const cells = $(tr).find('td').map((___, td) => $(td).text().trim()).get();
      if (cells.length < 3) return;
      clients.push({ id: cells[0], name: cells[1], password: cells[2] });
    });
  });
  return clients;
}

function parsePayouts(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('table').each((_, table) => {
    const headers = $(table).find('th').map((__, th) => $(th).text().trim().toUpperCase()).get();
    if (!headers.includes('NUMBER') || !headers.includes('STATUS')) return;
    $(table).find('tr').each((__, tr) => {
      const cells = $(tr).find('td').map((___, td) => $(td).text().trim()).get();
      if (cells.length < 8) return;
      rows.push({
        number: cells[0],
        sender: cells[1],
        messages: cells[2],
        range: cells[3],
        client: cells[4],
        status: cells[5],
        rate: cells[6],
        currency: cells[7],
      });
    });
  });
  return rows;
}

function parseTodaySoFar(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('table').each((_, table) => {
    const headers = $(table).find('th').map((__, th) => $(th).text().trim().toUpperCase()).get();
    if (!headers.includes('NUMBER') || !headers.includes('MESSAGES')) return;
    $(table).find('tr').each((__, tr) => {
      const cells = $(tr).find('td').map((___, td) => $(td).text().trim()).get();
      if (cells.length < 6) return;
      rows.push({
        number: cells[0],
        sender: cells[1],
        messages: cells[2],
        charge: cells[3],
        range: cells[4],
        client: cells[5],
        status: cells[6] || '',
      });
    });
  });
  return rows;
}

function parseTodaySummary(html) {
  const $ = cheerio.load(html);
  const statusSummary = [];
  const rangeSummary = [];
  const tables = $('table').toArray();

  for (const table of tables) {
    const headers = $(table).find('th').map((_, th) => $(th).text().trim().toUpperCase()).get();
    if (headers.includes('STATUS') && headers.includes('MESSAGES') && !headers.includes('RANGE')) {
      $(table).find('tr').each((_, tr) => {
        const cells = $(tr).find('td').map((__, td) => $(td).text().trim()).get();
        if (cells.length >= 2) {
          statusSummary.push({ status: cells[0], messages: cells[1] });
        }
      });
    } else if (headers.includes('RANGE') && headers.includes('STATUS') && headers.includes('MESSAGES')) {
      $(table).find('tr').each((_, tr) => {
        const cells = $(tr).find('td').map((__, td) => $(td).text().trim()).get();
        if (cells.length >= 3) {
          rangeSummary.push({ range: cells[0], status: cells[1], messages: cells[2] });
        }
      });
    }
  }
  return { statusSummary, rangeSummary };
}

function parseSenderSummaries(html) {
  const $ = cheerio.load(html);
  const senders = [];
  $('table').each((_, table) => {
    const headers = $(table).find('th').map((__, th) => $(th).text().trim().toUpperCase()).get();
    if (!headers.includes('SENDER') || !headers.includes('MESSAGES')) return;
    $(table).find('tr').each((__, tr) => {
      const cells = $(tr).find('td').map((___, td) => $(td).text().trim()).get();
      if (cells.length < 2) return;
      senders.push({ sender: cells[0], messages: cells[1] });
    });
  });
  return senders;
}

function parseStatements(html) {
  const $ = cheerio.load(html);
  const statements = [];
  $('table').each((_, table) => {
    const headers = $(table).find('th').map((__, th) => $(th).text().trim().toUpperCase()).get();
    if (!headers.includes('REFERENCE') || !headers.includes('PAYOUT')) return;
    $(table).find('tr').each((__, tr) => {
      const cells = $(tr).find('td').map((___, td) => $(td).text().trim()).get();
      if (cells.length < 9) return;
      statements.push({
        reference: cells[0],
        dateFrom: cells[1],
        dateTo: cells[2],
        generatedOn: cells[3],
        status: cells[4],
        payout: cells[5],
        currency: cells[6],
        terms: cells[7],
        due: cells[8],
      });
    });
  });
  return statements;
}

function resultKey(r) {
  return `${r.date}|${r.ddi}|${r.termination}`;
}

function formatMessage(r) {
  const emoji = r.status.toUpperCase() === 'PAID' ? '\u{1F7E2}' : r.status.toUpperCase() === 'UNPAID' ? '\u{1F534}' : '\u26AA';
  return (
    `${emoji} *New SMS test result*\n` +
    `*Date:* ${r.date}\n` +
    `*Termination:* ${r.termination}\n` +
    `*DDI:* ${r.ddi}\n` +
    `*CLI:* ${r.cli}\n` +
    `*Status:* *${r.status}*`
  );
}

module.exports = {
  PortalClient,
  parseResults,
  parseRateCard,
  parseAllocatedNumbers,
  parseClients,
  parsePayouts,
  parseTodaySoFar,
  parseTodaySummary,
  parseSenderSummaries,
  parseStatements,
  resultKey,
  formatMessage,
};
