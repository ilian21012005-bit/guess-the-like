/**
 * Tests du scraper : getTikTokMp4Buffer (URL invalide, erreur → context fermé, pas de crash).
 */
const { getTikTokMp4Buffer } = require('./scraper');

describe('getTikTokMp4Buffer', () => {
  it('retourne { error } pour URL non TikTok', async () => {
    const out = await getTikTokMp4Buffer('https://example.com/not-tiktok');
    expect(out.buffer).toBeUndefined();
    expect(out.error).toBeDefined();
    expect(out.error).toContain('invalide');
  });

  it('retourne { error } pour chaîne vide', async () => {
    const out = await getTikTokMp4Buffer('');
    expect(out.buffer).toBeUndefined();
    expect(out.error).toBeDefined();
  });

  it('ne crash pas et retourne soit { error } soit { buffer } pour URL TikTok valide', async () => {
    const out = await getTikTokMp4Buffer('https://www.tiktok.com/@x/video/999');
    expect(out).toBeDefined();
    expect(out.error !== undefined || out.buffer !== undefined).toBe(true);
  }, 20000);
});
