/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.js'],
  collectCoverageFrom: ['db.js', 'server.js', 'scraper.js'],
  coverageDirectory: 'coverage',
  verbose: true,
};
