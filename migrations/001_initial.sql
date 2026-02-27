-- Guess The Like - Schéma initial PostgreSQL
CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL,
    tiktok_username VARCHAR(100),
    avatar_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_likes (
    id SERIAL PRIMARY KEY,
    player_id INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    video_url TEXT NOT NULL,
    video_id_tiktok VARCHAR(50) UNIQUE,
    play_count INT DEFAULT 0,
    last_played_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS play_history (
    id SERIAL PRIMARY KEY,
    room_code VARCHAR(20) NOT NULL,
    video_id INT NOT NULL REFERENCES user_likes(id) ON DELETE CASCADE,
    played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rooms (
    id SERIAL PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,
    host_socket_id VARCHAR(100),
    status VARCHAR(20) DEFAULT 'lobby',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS room_players (
    id SERIAL PRIMARY KEY,
    room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    player_id INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    socket_id VARCHAR(100) NOT NULL,
    is_ready BOOLEAN DEFAULT FALSE,
    score INT DEFAULT 0,
    streak INT DEFAULT 0,
    UNIQUE(room_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_user_likes_player ON user_likes(player_id);
CREATE INDEX IF NOT EXISTS idx_play_history_room ON play_history(room_code);
CREATE INDEX IF NOT EXISTS idx_play_history_video ON play_history(video_id);
CREATE INDEX IF NOT EXISTS idx_room_players_room ON room_players(room_id);
