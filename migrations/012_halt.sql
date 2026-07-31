-- Ticket 14: product-wide gateway halt switch (spec §49).
-- Single-row table; the CHECK-pinned primary key makes a second row impossible.
CREATE TABLE IF NOT EXISTS system_halt (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  halted     boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_halt (halted) VALUES (false)
ON CONFLICT (singleton) DO NOTHING;
