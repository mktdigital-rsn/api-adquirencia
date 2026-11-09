CREATE TABLE IF NOT EXISTS credit_events (
 id INTEGER PRIMARY KEY,
 producer TEXT NOT NULL CHECK(length(producer)<=100),
 event_id TEXT NOT NULL CHECK(length(event_id)=36),
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 received_at TEXT NOT NULL,
 CONSTRAINT credit_events_identity UNIQUE(producer,event_id)
);
CREATE TABLE IF NOT EXISTS credit_leads (
 id INTEGER PRIMARY KEY,
 event_pk INTEGER NOT NULL UNIQUE REFERENCES credit_events(id),
 producer TEXT NOT NULL CHECK(length(producer)<=100),
 lead_id TEXT NOT NULL CHECK(length(lead_id)<=128),
 origem TEXT NOT NULL CHECK(origem IN ('PUBLICA','AGENTE','IB')),
 status TEXT NOT NULL CHECK(status='PENDENTE'),
 created_at TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)),
 CONSTRAINT credit_leads_identity UNIQUE(producer,lead_id)
);
CREATE INDEX IF NOT EXISTS credit_leads_origin ON credit_leads(origem);
CREATE INDEX IF NOT EXISTS credit_leads_created ON credit_leads(created_at);
