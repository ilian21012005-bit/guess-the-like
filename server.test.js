/**
 * Tests de la route /api/tiktok-video (timeout → fallback JSON, erreurs).
 */
jest.mock('./scraper', () => ({
  harvestLikes: jest.fn(),
  getTikTokMp4Url: jest.fn(() => new Promise(() => {})),
  getTikTokMp4Buffer: jest.fn(() => new Promise(() => {})),
}));

process.env.NODE_ENV = 'test';
process.env.VIDEO_EXTRACT_TIMEOUT_MS = '80';
process.env.USE_PLAYWRIGHT_DIRECT = '0';

const request = require('supertest');
const { app } = require('./server');

describe('GET /api/tiktok-video', () => {
  const validUrl = 'https://www.tiktok.com/@user/video/123456789';

  it('répond 400 si url manquant', async () => {
    const res = await request(app).get('/api/tiktok-video');
    expect(res.status).toBe(400);
  });

  it('répond 403 si URL non TikTok', async () => {
    const res = await request(app).get('/api/tiktok-video?url=https://evil.com/video/1');
    expect(res.status).toBe(403);
  });

  it('en cas de timeout renvoie 200 + JSON fallback (fallbackUrl, error)', async () => {
    const res = await request(app)
      .get('/api/tiktok-video?url=' + encodeURIComponent(validUrl))
      .timeout(500);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = JSON.parse(res.text);
    expect(body.fallbackUrl).toBe(validUrl);
    expect(body.error).toBe('TIMEOUT');
  }, 1000);
});
