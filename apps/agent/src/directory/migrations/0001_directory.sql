CREATE TABLE owners (
  owner_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL
);

CREATE TABLE channel_identities (
  channel_identity TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owners (owner_id)
);

CREATE INDEX channel_identities_owner ON channel_identities (owner_id);

CREATE TABLE registration (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed'))
);

INSERT INTO registration (singleton, state) VALUES (1, 'closed');
