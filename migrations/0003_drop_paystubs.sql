-- Reverts 0002: pay stubs are now a stateless report generated on demand from
-- current session data (see CLAUDE.md), not a locked, persisted record. Data
-- integrity instead comes from the 31-day tutor edit window in the Worker.

DROP TABLE paystub_lines;
DROP TABLE paystubs;
ALTER TABLE sessions DROP COLUMN paystub_id;
