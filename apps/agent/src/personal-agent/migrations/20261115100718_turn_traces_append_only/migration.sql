CREATE TRIGGER turn_traces_no_update
BEFORE UPDATE ON turn_traces
BEGIN SELECT RAISE(ABORT, 'Traces are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER turn_traces_no_delete
BEFORE DELETE ON turn_traces
BEGIN SELECT RAISE(ABORT, 'Traces are append-only'); END;
