-- Only counters and per-article random-event receipts; no raw IP/user agent.
CREATE TABLE IF NOT EXISTS view_totals (
  article_id TEXT PRIMARY KEY,
  views INTEGER NOT NULL DEFAULT 0 CHECK(views >= 0 AND views <= 9007199254740991)
);
CREATE TABLE IF NOT EXISTS view_receipts (
  article_id TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (article_id, event_hash)
);
CREATE INDEX IF NOT EXISTS view_receipts_expiry ON view_receipts(expires_at);
CREATE TABLE IF NOT EXISTS view_daily_budget (
  day TEXT PRIMARY KEY,
  events INTEGER NOT NULL CHECK(events >= 0 AND events <= 5000)
);
CREATE TRIGGER IF NOT EXISTS view_budget_before_insert
BEFORE INSERT ON view_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM view_receipts WHERE article_id = NEW.article_id AND event_hash = NEW.event_hash
) AND COALESCE((SELECT events FROM view_daily_budget WHERE day = date('now')), 0) >= 5000
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER IF NOT EXISTS view_count_after_insert
AFTER INSERT ON view_receipts
BEGIN
  INSERT INTO view_totals(article_id, views) VALUES(NEW.article_id, 1)
    ON CONFLICT(article_id) DO UPDATE SET views = views + 1;
  INSERT INTO view_daily_budget(day, events) VALUES(date('now'), 1)
    ON CONFLICT(day) DO UPDATE SET events = events + 1;
END;
