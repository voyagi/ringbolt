-- Fixed windows for the rate limits. One row per bucket per window, so a storm costs a bounded
-- number of rows rather than one per request.
--
-- It is a table rather than a Durable Object because the thing being counted is already a database
-- write: an alert that gets through opens an incident, so the limiter reads and writes where the
-- work is, and a limiter in another isolate would be a second place for the count to disagree.
CREATE TABLE rate_windows (
  bucket TEXT NOT NULL,
  window_start TEXT NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

-- Nothing else removes rows from this table, and an endpoint anybody can reach writes to it.
CREATE INDEX rate_windows_start ON rate_windows (window_start);
