import m0000 from "./0000_personal_agent.sql";
import m0001 from "./0001_journal_append_only.sql";
import journal from "./meta/_journal.json";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
};
