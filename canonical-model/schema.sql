CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(32) NOT NULL CHECK (type IN ('EMPLOYEE','AGENT','WORKFLOW','TOOL','MODEL','VENDOR')),
  name VARCHAR(255) NOT NULL,
  source VARCHAR(64) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_id)
);

CREATE TABLE dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_entity UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type VARCHAR(64) NOT NULL,
  criticality NUMERIC(3,2) DEFAULT 0.50,
  evidence_source VARCHAR(64) NOT NULL
);

CREATE TABLE evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  fact VARCHAR(255) NOT NULL,
  value TEXT,
  source VARCHAR(64) NOT NULL,
  state VARCHAR(32) NOT NULL CHECK (state IN ('stated','inferred','confirmed','unknown')),
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_dependencies_edge
  ON dependencies(from_entity, to_entity, type, evidence_source);
CREATE INDEX idx_dependencies_from ON dependencies(from_entity);
CREATE INDEX idx_dependencies_to ON dependencies(to_entity);
CREATE INDEX idx_evidence_entity ON evidence(entity_id);
