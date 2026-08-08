-- Ticket 07: a Group's cadence is an interruption budget, not a polling rate.
-- NULL is daily — one window a day at local_time, whose items wait for the one
-- daily message and never interrupt. A number is the interval in hours: the
-- window closes every N hours and pushes what it finds for the Account holder.
--
-- Free is refused an interval at the API boundary rather than capped here: one
-- Group on a four-hour cadence opens six windows a day against an allowance of
-- five Summaries, which would starve every other Group on the Account.
ALTER TABLE summary_schedules ADD COLUMN IF NOT EXISTS interval_hours int
  CHECK (interval_hours IS NULL OR interval_hours BETWEEN 1 AND 12);
