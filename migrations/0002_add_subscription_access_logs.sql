-- Migration to add subscription_access_logs table

CREATE TABLE IF NOT EXISTS subscription_access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  country TEXT,
  city TEXT,
  accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE
);