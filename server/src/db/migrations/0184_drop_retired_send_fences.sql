-- The customer-email-direction and vendor-email contracts were retired (build #845).
-- Their tables stay for history, but these triggers would keep fencing ordinary
-- approved email drafts to the same account and recipient forever.
DROP TRIGGER IF EXISTS customer_email_ordinary_claim;
DROP TRIGGER IF EXISTS customer_email_insert_claim;
DROP TRIGGER IF EXISTS vendor_email_ordinary_claim;
DROP TRIGGER IF EXISTS vendor_email_insert_claim;
