import m0000 from "./20261114132133_personal_agent/migration.sql";
import m0001 from "./20261114132301_journal_append_only/migration.sql";
import m0002 from "./20261115100716_turn_traces/migration.sql";
import m0003 from "./20261115100718_turn_traces_append_only/migration.sql";

export default {
  migrations: {
    "20261114132133_personal_agent": m0000,
    "20261114132301_journal_append_only": m0001,
    "20261115100716_turn_traces": m0002,
    "20261115100718_turn_traces_append_only": m0003,
  },
};
