UPDATE credit_leads
SET created_at = substr(created_at, 1, 26) || '000Z'
WHERE length(created_at) = 27 AND substr(created_at, 27, 1) = 'Z';
