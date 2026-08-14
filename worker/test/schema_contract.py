import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


def columns(db: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in db.execute(f"PRAGMA table_info({table})")}


def test_schema_matches_product_contract() -> None:
    db = sqlite3.connect(":memory:")
    for migration in sorted(MIGRATIONS.glob("*.sql")):
        db.executescript(migration.read_text())

    item_cols = columns(db, "job_items")
    assert "shipping" in item_cols

    customer_cols = columns(db, "customers")
    assert "name" not in customer_cols
    assert "phone" not in customer_cols
    assert {"wechat_qr", "avatar_photo", "openid"} <= customer_cols

    part_cols = columns(db, "parts")
    assert "last_cost" not in part_cols
    assert "last_charge" not in part_cols

    job_cols = columns(db, "jobs")
    # receipt_no identifies the document handed to the customer; local_date is
    # the device's own calendar day. Neither can be reconstructed from
    # created_at alone, so a round trip that drops them loses ledger meaning.
    assert "receipt_no" in job_cols
    assert "local_date" in job_cols

    # Two jobs on one device must never share a receipt number.
    indexes = {row[1] for row in db.execute("PRAGMA index_list(jobs)")}
    assert "idx_jobs_receipt" in indexes, f"missing unique receipt index: {indexes}"


if __name__ == "__main__":
    test_schema_matches_product_contract()
    print("PASS schema matches product contract")
