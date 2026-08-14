-- The PWA carries two fields the schema had no home for.
--
-- receipt_no is printed on the sheet handed to the customer, so it must survive
-- a sync round trip verbatim: it is the identifier he points at when a customer
-- disputes a job weeks later.
--
-- local_date is the calendar day the job was filed under, in the device's own
-- timezone. It cannot be derived from created_at without knowing the offset,
-- and a job finished at 00:30 must stay on that day rather than sliding into
-- the previous one in UTC.
ALTER TABLE jobs ADD COLUMN receipt_no TEXT;
ALTER TABLE jobs ADD COLUMN local_date TEXT;

-- Receipt numbers are sequential per device per day; two jobs sharing one would
-- undermine the document's purpose.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_receipt
  ON jobs(device_id, receipt_no) WHERE receipt_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_local_date ON jobs(device_id, local_date);
