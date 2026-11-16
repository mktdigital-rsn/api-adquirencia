CREATE TABLE IF NOT EXISTS credit_document_alerts (
 id INTEGER PRIMARY KEY,
 event_pk INTEGER NOT NULL UNIQUE REFERENCES credit_events(id),
 producer TEXT NOT NULL CHECK(length(producer)<=100),
 lead_id TEXT NOT NULL CHECK(length(lead_id)<=128),
 collection_link_id TEXT NOT NULL CHECK(length(collection_link_id)<=128),
 CONSTRAINT credit_document_alert_identity UNIQUE(producer,collection_link_id)
);
CREATE INDEX IF NOT EXISTS credit_document_alerts_lead ON credit_document_alerts(producer,lead_id);
