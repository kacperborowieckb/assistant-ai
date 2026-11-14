CREATE TRIGGER journal_entries_no_update
BEFORE UPDATE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'The Journal is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER journal_entries_no_delete
BEFORE DELETE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'The Journal is append-only'); END;
