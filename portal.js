'use strict';

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');

const BASE_URL = 'http://mysmsportal.com';
const LOGIN_URL = `${BASE_URL}/index.php?login=1`;
const TEST_NUMBERS_URL = `${BASE_URL}/index.php?opt=shw_test_np`;
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

  async fetchResultsPage() {
    let resp = await request(this.jar, 'GET', TEST_NUMBERS_URL);
    if (resp.status >= 400) throw new Error(`Fetch HTTP ${resp.status}`);
    if (/Please enter your login details/i.test(resp.data || '')) {
      this.log.warn('Session expired, re-logging in');
      await this.login();
      resp = await request(this.jar, 'GET', TEST_NUMBERS_URL);
      if (resp.status >= 400) throw new Error(`Fetch after re-login HTTP ${resp.status}`);
    }
    return resp.data;
  }
}

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

module.exports = { PortalClient, parseResults, resultKey, formatMessage };
