import m0000 from "./20261114132133_personal_agent/migration.sql";
import m0001 from "./20261114132301_journal_append_only/migration.sql";
import m0002 from "./20261115100716_turn_traces/migration.sql";
import m0003 from "./20261115100718_turn_traces_append_only/migration.sql";
import m0004 from "./20261115141734_conversation_model_messages/migration.sql";
import m0005 from "./20261115145059_notes/migration.sql";
import m0006 from "./20261115153100_turn_progress/migration.sql";
import m0007 from "./20261115172013_notes_search/migration.sql";
import m0008 from "./20261115175723_note_links/migration.sql";
import m0009 from "./20261115183520_profile_entries/migration.sql";
import m0010 from "./20261115191148_forwarded_messages/migration.sql";

export default {
  migrations: {
    "20261114132133_personal_agent": m0000,
    "20261114132301_journal_append_only": m0001,
    "20261115100716_turn_traces": m0002,
    "20261115100718_turn_traces_append_only": m0003,
    "20261115141734_conversation_model_messages": m0004,
    "20261115145059_notes": m0005,
    "20261115153100_turn_progress": m0006,
    "20261115172013_notes_search": m0007,
    "20261115175723_note_links": m0008,
    "20261115183520_profile_entries": m0009,
    "20261115191148_forwarded_messages": m0010,
  },
};
