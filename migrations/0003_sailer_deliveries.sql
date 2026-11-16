CREATE TABLE IF NOT EXISTS sailer_deliveries (
 id INTEGER PRIMARY KEY,
 event_pk INTEGER NOT NULL UNIQUE REFERENCES credit_events(id),
 payload TEXT CHECK(payload IS NULL OR json_valid(payload)),
 status TEXT NOT NULL CHECK(status IN ('pending','processing','delivered','blocked','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 next_attempt_ms INTEGER NOT NULL,
 first_attempt_ms INTEGER,
 lease_until_ms INTEGER,
 claim_token TEXT,
 delivered_at TEXT,
 last_http_status INTEGER,
 last_error_code TEXT,
 CHECK(status != 'processing' OR (claim_token IS NOT NULL AND lease_until_ms IS NOT NULL)),
 CHECK(status = 'blocked' OR payload IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS sailer_deliveries_pending ON sailer_deliveries(status,next_attempt_ms);
CREATE TABLE IF NOT EXISTS sailer_delivery_rate (
 id INTEGER PRIMARY KEY CHECK(id=1),
 next_send_ms INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO sailer_delivery_rate(id,next_send_ms) VALUES(1,0);
