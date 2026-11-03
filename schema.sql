-- ============================================================
-- Vip Bingo — MySQL schema
-- ============================================================
SET NAMES utf8mb4;

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(64) UNIQUE NOT NULL,
    email VARCHAR(190) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(190),
    role VARCHAR(20) DEFAULT 'cashier',
    is_active TINYINT(1) DEFAULT 1,
    email_verified TINYINT(1) DEFAULT 0,
    failed_login_attempts INT DEFAULT 0,
    locked_until DATETIME NULL,
    password_changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- SESSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
    sid VARCHAR(128) PRIMARY KEY,
    sess TEXT NOT NULL,
    expire BIGINT NOT NULL,
    INDEX idx_sessions_expire (expire)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- LOGIN AUDIT
-- ============================================================
CREATE TABLE IF NOT EXISTS login_audit (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NULL,
    username_attempted VARCHAR(64),
    email_attempted VARCHAR(190),
    ip_address VARCHAR(64),
    user_agent TEXT,
    success TINYINT(1) DEFAULT 0,
    reason VARCHAR(190),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_login_audit_user (user_id),
    INDEX idx_login_audit_date (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- CARTELAS
-- ============================================================
CREATE TABLE IF NOT EXISTS cartelas (
    id INT PRIMARY KEY,
    serial VARCHAR(64) UNIQUE,
    numbers TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- GAMES
-- ============================================================
CREATE TABLE IF NOT EXISTS games (
    id INT PRIMARY KEY AUTO_INCREMENT,
    game_number VARCHAR(64) UNIQUE NOT NULL,
    status VARCHAR(20) DEFAULT 'waiting',
    draw_interval INT DEFAULT 4000,
    total_cards INT DEFAULT 0,
    prize_pool DECIMAL(12,2) DEFAULT 0,
    winner_count INT DEFAULT 0,
    start_time DATETIME NULL,
    end_time DATETIME NULL,
    last_draw_time DATETIME NULL,
    last_heartbeat DATETIME NULL,
    created_by INT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_games_status (status),
    CONSTRAINT fk_games_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- CALLED NUMBERS
-- ============================================================
CREATE TABLE IF NOT EXISTS called_numbers (
    id INT PRIMARY KEY AUTO_INCREMENT,
    game_id INT NOT NULL,
    number INT NOT NULL,
    called_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_game_number (game_id, number),
    INDEX idx_called_game (game_id),
    CONSTRAINT fk_called_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- TICKETS
-- ============================================================
CREATE TABLE IF NOT EXISTS tickets (
    id INT PRIMARY KEY AUTO_INCREMENT,
    ticket_number VARCHAR(64) NOT NULL,
    cartela_id INT NOT NULL,
    game_id INT NOT NULL,
    price DECIMAL(12,2) NOT NULL,
    sold_by VARCHAR(64),
    status VARCHAR(20) DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_ticket_game (ticket_number, game_id),
    INDEX idx_tickets_game (game_id),
    INDEX idx_tickets_cartela (cartela_id),
    INDEX idx_tickets_status (status),
    CONSTRAINT fk_tickets_cartela FOREIGN KEY (cartela_id) REFERENCES cartelas(id),
    CONSTRAINT fk_tickets_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- WINNERS
-- ============================================================
CREATE TABLE IF NOT EXISTS winners (
    id INT PRIMARY KEY AUTO_INCREMENT,
    game_id INT NOT NULL,
    ticket_id INT NOT NULL,
    cartela_id INT NOT NULL,
    prize_type VARCHAR(64),
    prize_amount DECIMAL(12,2) DEFAULT 0,
    winner_rank INT DEFAULT 1,
    win_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_winners_game (game_id),
    CONSTRAINT fk_winners_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    CONSTRAINT fk_winners_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id),
    CONSTRAINT fk_winners_cartela FOREIGN KEY (cartela_id) REFERENCES cartelas(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- WALLET (single-row)
-- ============================================================
CREATE TABLE IF NOT EXISTS wallet (
    id INT PRIMARY KEY,
    balance DECIMAL(12,2) DEFAULT 0.00,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- WALLET TRANSACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    transaction_id VARCHAR(64) UNIQUE,
    transaction_type VARCHAR(32) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    balance_before DECIMAL(12,2) NOT NULL,
    balance_after DECIMAL(12,2) NOT NULL,
    description TEXT,
    created_by VARCHAR(64),
    reference_id INT NULL,
    reference_type VARCHAR(32) NULL,
    status VARCHAR(20) DEFAULT 'completed',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_wallet_tx (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- SETTINGS (single-row)
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
    id INT PRIMARY KEY,
    house_balance DECIMAL(12,2) DEFAULT 0.00,
    thicket_price DECIMAL(12,2) DEFAULT 10.00,
    draw_interval INT DEFAULT 4000,
    first_draw_delay_ms INT DEFAULT 3500,
    winning_patterns TEXT,
    patterns_required INT DEFAULT 1,
    max_winners INT DEFAULT 3,
    first_winner_share DECIMAL(5,2) DEFAULT 80.0,
    second_winner_share DECIMAL(5,2) DEFAULT 15.0,
    third_winner_share DECIMAL(5,2) DEFAULT 5.0,
    prize_distribution_winner DECIMAL(5,2) DEFAULT 80.0,
    prize_distribution_house DECIMAL(5,2) DEFAULT 20.0,
    commission_enabled TINYINT(1) DEFAULT 1,
    commission_mode VARCHAR(20) DEFAULT 'auto',
    commission_tier INT DEFAULT 0,
    commission_rate DECIMAL(5,2) DEFAULT 0,
    commission_min DECIMAL(12,2) DEFAULT 0,
    commission_max DECIMAL(12,2) DEFAULT 0,
    commission_tier1_min DECIMAL(12,2) DEFAULT 500,
    commission_tier1_max DECIMAL(12,2) DEFAULT 1000,
    commission_tier1_pct DECIMAL(5,2) DEFAULT 15,
    commission_tier2_min DECIMAL(12,2) DEFAULT 1100,
    commission_tier2_max DECIMAL(12,2) DEFAULT 1500,
    commission_tier2_pct DECIMAL(5,2) DEFAULT 30,
    commission_tier3_min DECIMAL(12,2) DEFAULT 1600,
    commission_tier3_max DECIMAL(12,2) DEFAULT 3000,
    commission_tier3_pct DECIMAL(5,2) DEFAULT 35,
    commission_tier4_min DECIMAL(12,2) DEFAULT 3100,
    commission_tier4_max DECIMAL(12,2) DEFAULT 6000,
    commission_tier4_pct DECIMAL(5,2) DEFAULT 40,
    jackpot_enabled TINYINT(1) DEFAULT 0,
    jackpot_balance DECIMAL(12,2) DEFAULT 0.00,
    jackpot_contribution_pct DECIMAL(5,2) DEFAULT 10.0,
    jackpot_games_required INT DEFAULT 6,
    jackpot_games_counter INT DEFAULT 0,
    jackpot_armed TINYINT(1) DEFAULT 0,
    jackpot_last_won_game INT DEFAULT 0,
    jackpot_min_players INT DEFAULT 20,
    jackpot_win_pattern VARCHAR(64) DEFAULT 'full_house',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- COMMISSION TIERS  ← NEW table (used by commissionService)
-- ============================================================
CREATE TABLE IF NOT EXISTS commission_tiers (
    tier INT PRIMARY KEY,
    min DECIMAL(12,2) NOT NULL,
    max DECIMAL(12,2) NOT NULL,
    rate DECIMAL(5,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- COMMISSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS commissions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    game_id INT NOT NULL,
    seller VARCHAR(64) NOT NULL,
    ticket_count INT DEFAULT 0,
    total_sales DECIMAL(12,2) DEFAULT 0,
    commission_pct DECIMAL(5,2) DEFAULT 0,
    commission_amount DECIMAL(12,2) DEFAULT 0,
    tier_applied VARCHAR(64),
    payout_status VARCHAR(20) DEFAULT 'pending',
    paid_at DATETIME NULL,
    paid_by VARCHAR(64),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_commissions_game (game_id),
    CONSTRAINT fk_commissions_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- JACKPOT HISTORY
-- ============================================================
CREATE TABLE IF NOT EXISTS jackpot_history (
    id INT PRIMARY KEY AUTO_INCREMENT,
    game_id INT NULL,
    event_type VARCHAR(32) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    balance_before DECIMAL(12,2) NOT NULL,
    balance_after DECIMAL(12,2) NOT NULL,
    winner_user_id INT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_jackpot_history (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- SEED SINGLETONS + DEFAULT TIERS
-- ============================================================
INSERT IGNORE INTO settings (id) VALUES (1);
INSERT IGNORE INTO wallet (id, balance) VALUES (1, 0.00);

-- Default commission tiers (safe to re-run — IGNORE skips existing)
INSERT IGNORE INTO commission_tiers (tier, min, max, rate) VALUES
    (0, 0,    499,  10),
    (1, 500,  1000, 15),
    (2, 1100, 1500, 30),
    (3, 1600, 3000, 35),
    (4, 3100, 6000, 40);
