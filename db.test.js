/**
 * Tests unitaires pour la logique DB (getVideosForRoom, etc.).
 * On mocke pg pour ne pas toucher à une vraie base.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';

const mockQuery = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({ query: mockQuery })),
}));

beforeEach(() => {
  mockQuery.mockReset();
});

const db = require('./db');

describe('getVideosForRoom', () => {
  it('retourne [] si pool est null', async () => {
    const originalPool = db.pool;
    db.pool = null;
    const out = await db.getVideosForRoom('ABC', [1], 10);
    expect(out).toEqual([]);
    db.pool = originalPool;
  });

  it('retourne [] si playerIds est vide', async () => {
    const out = await db.getVideosForRoom('ABC', [], 10);
    expect(out).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('retourne jusqu’à limit vidéos jamais vues (aucune dans play_history)', async () => {
    const rows = [
      { id: 10, video_url: 'https://tiktok.com/@a/video/1', player_id: 1 },
      { id: 11, video_url: 'https://tiktok.com/@a/video/2', player_id: 1 },
    ];
    mockQuery.mockResolvedValueOnce({ rows });
    const out = await db.getVideosForRoom('ROOM1', [1], 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: 10, video_url: rows[0].video_url, owner_id: 1 });
    expect(out[1]).toEqual({ id: 11, video_url: rows[1].video_url, owner_id: 1 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('play_history');
    expect(params).toEqual([1]);
  });

  it('utilise le fallback si la requête principale ne renvoie pas assez de lignes', async () => {
    const mainRows = [
      { id: 20, video_url: 'https://tiktok.com/@b/video/1', player_id: 2 },
    ];
    const fallbackRows = [
      { id: 21, video_url: 'https://tiktok.com/@b/video/2', player_id: 2 },
      { id: 22, video_url: 'https://tiktok.com/@b/video/3', player_id: 2 },
    ];
    mockQuery.mockResolvedValueOnce({ rows: mainRows });
    mockQuery.mockResolvedValueOnce({ rows: fallbackRows });
    const out = await db.getVideosForRoom('ROOM2', [2], 3);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.id)).toEqual([20, 21, 22]);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const fallbackSql = mockQuery.mock.calls[1][0];
    expect(fallbackSql).toContain('play_count');
    expect(fallbackSql).toContain('last_played_at');
  });

  it('respecte la limite (cap) entre 1 et 50', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({
      id: 100 + i,
      video_url: `https://tiktok.com/@x/video/${i}`,
      player_id: 1,
    }));
    mockQuery.mockResolvedValueOnce({ rows: fifty });
    const out = await db.getVideosForRoom('X', [1], 50);
    expect(out).toHaveLength(50);
  });

  it('exclut les vidéos déjà dans play_history (filtre global, pas room_code)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await db.getVideosForRoom('ANYROOM', [1, 2], 10);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1\s+FROM play_history ph\s+WHERE ph\.video_id = ul\.id\s*\)/);
    expect(sql).not.toContain('room_code');
  });
});

describe('recordPlayedVideo', () => {
  it('appelle INSERT play_history et UPDATE user_likes', async () => {
    mockQuery.mockResolvedValueOnce(undefined);
    mockQuery.mockResolvedValueOnce(undefined);
    await db.recordPlayedVideo('ROOM', 42);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0]).toContain('INSERT INTO play_history');
    expect(mockQuery.mock.calls[0][1]).toEqual(['ROOM', 42]);
    expect(mockQuery.mock.calls[1][0]).toContain('UPDATE user_likes');
    expect(mockQuery.mock.calls[1][1]).toEqual([42]);
  });
});
