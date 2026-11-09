SELECT producer, count(*) AS events, min(received_at) AS first_received, max(received_at) AS last_received FROM credit_events GROUP BY producer;
SELECT origem, count(*) AS leads FROM credit_leads GROUP BY origem;
SELECT count(*) AS events_without_lead FROM credit_events e LEFT JOIN credit_leads l ON l.event_pk=e.id WHERE l.id IS NULL;
