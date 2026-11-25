-- Additive and replay-safe: existing creation snapshots and legacy alerts stay intact.
CREATE TABLE IF NOT EXISTS credit_lifecycle_events (
 id INTEGER PRIMARY KEY,
 event_pk INTEGER NOT NULL UNIQUE REFERENCES credit_events(id),
 producer TEXT NOT NULL,
 lead_id TEXT NOT NULL,
 event_type TEXT NOT NULL,
 kind TEXT NOT NULL,
 reference_id TEXT NOT NULL,
 reminder_number INTEGER NOT NULL CHECK(reminder_number IN (0,1,2)),
 UNIQUE(producer,lead_id,event_type,reference_id,reminder_number)
);
CREATE INDEX IF NOT EXISTS credit_lifecycle_cycle ON credit_lifecycle_events(producer,lead_id,kind,reference_id);
INSERT OR IGNORE INTO credit_lifecycle_events(event_pk,producer,lead_id,event_type,kind,reference_id,reminder_number)
 SELECT event_pk,producer,lead_id,'credit.lead.documents.overdue','documents',collection_link_id,1 FROM credit_document_alerts;
