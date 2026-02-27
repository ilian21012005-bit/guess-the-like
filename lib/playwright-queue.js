const config = require('../config');
const { getTikTokMp4Buffer } = require('../scraper');

const PLAYWRIGHT_CONCURRENT = config.PLAYWRIGHT_CONCURRENT;
let playwrightMissingLogged = false;
const queue = [];
let running = 0;

function runQueue() {
  while (running < PLAYWRIGHT_CONCURRENT && queue.length > 0) {
    const { pageUrl, resolve } = queue.shift();
    running++;
    getTikTokMp4Buffer(pageUrl)
      .then((result) => {
        running--;
        resolve(result);
        runQueue();
      })
      .catch((err) => {
        running--;
        resolve({ error: err.message || 'BUFFER_ERROR' });
        runQueue();
      });
  }
}

function enqueue(pageUrl) {
  return new Promise((resolve) => {
    queue.push({ pageUrl, resolve });
    runQueue();
  });
}

function setPlaywrightMissingLogged(value) {
  playwrightMissingLogged = value;
}

function getPlaywrightMissingLogged() {
  return playwrightMissingLogged;
}

module.exports = {
  enqueue,
  setPlaywrightMissingLogged,
  getPlaywrightMissingLogged,
};
