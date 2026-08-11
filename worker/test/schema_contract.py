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


if __name__ == "__main__":
    test_schema_matches_product_contract()
    print("PASS schema matches product contract")
