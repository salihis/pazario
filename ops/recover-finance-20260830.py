"""Targeted, approved recovery of empty HB financial fields from the Aug 25 dump.

Default is a dry run. --apply requires exactly the approved 36 rows / 73 fields.
Locks and compares current values before writing; concurrent edits are skipped.
No orders/items are inserted or deleted. Journals and safety dump are mode 0600.
"""
import argparse
import importlib.util
import json
import os
import subprocess
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('finance_audit', Path(__file__).with_name('audit-finance-backups.py'))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
BACKUP = Path('/home/ubuntu/pazario-backups/daily/pazario-20260825-034502.dump')


def make_plan(report, current):
    by_id = {row['id']: row for row in current}
    plan = []
    seen = set()
    for candidate in report['candidatesForReview']:
        if candidate['marketplace'] != 'HEPSIBURADA' or not candidate['rowWasRecreated']:
            continue
        row = by_id[candidate['itemId']]
        if row['orderId'] != candidate['orderId'] or row['marketplace'] != 'HEPSIBURADA':
            raise ValueError('Identity changed; stop')
        for field, change in candidate['changes'].items():
            if field not in AUDIT.FIELDS:
                raise ValueError('Unapproved field; stop')
            if not change['currentlyEmpty'] or AUDIT.meaningful(row, field):
                continue
            key = (row['id'], field)
            if key in seen:
                raise ValueError('Ambiguous duplicate recovery target; stop')
            seen.add(key)
            value = Decimal(change['backup'])
            if not value.is_finite() or value != value.quantize(Decimal('0.01')):
                raise ValueError('Invalid backup amount; stop')
            plan.append({
                'itemId': row['id'], 'orderId': row['orderId'],
                'sku': row.get('sku'), 'marketplaceProductId': row.get('marketplaceProductId'),
                'field': field, 'expected': change['current'], 'restore': str(value),
            })
    return plan


def build_sql(plan):
    # Embed structured input as hex, never interpolate SKU/order text into SQL.
    payload = json.dumps(plan, ensure_ascii=True).encode('utf-8').hex()
    statements = [f'''BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TEMP TABLE recovery_plan ON COMMIT DROP AS
SELECT * FROM jsonb_to_recordset(convert_from(decode('{payload}', 'hex'), 'UTF8')::jsonb)
AS p("itemId" uuid, "orderId" uuid, sku text, "marketplaceProductId" text,
     field text, expected numeric, restore numeric);
CREATE TEMP TABLE recovery_changes (
  "itemId" uuid, "orderId" uuid, field text, before numeric, after numeric
) ON COMMIT DROP;
DO $$ BEGIN
  PERFORM i.id FROM order_items i
  JOIN (SELECT DISTINCT "itemId" FROM recovery_plan) p ON p."itemId"=i.id
  ORDER BY i.id FOR UPDATE OF i;
END; $$;''']
    for field in AUDIT.FIELDS:
        empty = f'i."{field}" IS NULL' if field == 'manualPurchasePrice' else f'i."{field}" = 0'
        statements.append(f'''
WITH changed AS (
  UPDATE order_items i SET "{field}"=p.restore
  FROM recovery_plan p, orders o
  WHERE p.field='{field}' AND i.id=p."itemId" AND i."orderId"=p."orderId"
    AND o.id=i."orderId" AND o.marketplace='HEPSIBURADA'
    AND i.sku IS NOT DISTINCT FROM p.sku
    AND i."marketplaceProductId" IS NOT DISTINCT FROM p."marketplaceProductId"
    AND i."{field}" IS NOT DISTINCT FROM p.expected
    AND {empty}
  RETURNING i.id AS "itemId", i."orderId", p.field, p.expected AS before, i."{field}" AS after
)
INSERT INTO recovery_changes SELECT * FROM changed;''')
    statements.append('''SELECT json_build_object(
 'plannedFields', (SELECT count(*) FROM recovery_plan),
 'restoredFields', (SELECT count(*) FROM recovery_changes),
 'restoredItems', (SELECT count(DISTINCT "itemId") FROM recovery_changes),
 'changes', (SELECT coalesce(json_agg(c), '[]'::json) FROM recovery_changes c)
);
COMMIT;''')
    return '\n'.join(statements)


def secure_json(path, data):
    with path.open('x', encoding='utf-8') as output:
        json.dump(data, output, indent=2, ensure_ascii=True, default=str)
        output.flush()
        os.fsync(output.fileno())


def verify(before, after, changes):
    old = {row['id']: row for row in before}
    new = {row['id']: row for row in after}
    applied = {(row['itemId'], row['field']): row['after'] for row in changes}
    errors = []
    for item_id, row in old.items():
        if item_id not in new:
            errors.append({'itemId': item_id, 'error': 'Row missing after recovery'})
            continue
        for field in AUDIT.FIELDS:
            key = (item_id, field)
            expected = applied[key] if key in applied else row.get(field)
            actual = new[item_id].get(field)
            if (None if expected is None else Decimal(str(expected))) != (None if actual is None else Decimal(str(actual))):
                errors.append({'itemId': item_id, 'field': field, 'error': 'Unexpected post-recovery value'})
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    before = AUDIT.current_items()
    report = AUDIT.compare(BACKUP, before)
    plan = make_plan(report, before)
    rows = len({row['itemId'] for row in plan})
    if not args.apply:
        print(json.dumps({'mode': 'DRY_RUN', 'items': rows, 'fields': len(plan)}))
        return
    if rows != 36 or len(plan) != 73:
        raise ValueError('Approved scope changed. Re-audit before applying recovery.')

    os.umask(0o077)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    folder = Path('/home/ubuntu/backups') / ('finance-recovery-' + stamp)
    folder.mkdir(mode=0o700)
    secure_json(folder / 'plan.json', {'sourceBackup': str(BACKUP), 'plan': plan, 'before': before})
    with (folder / 'before-orders.dump').open('xb') as backup:
        subprocess.run(
            ['docker', 'exec', AUDIT.CONTAINER, 'pg_dump', '-U', 'pazario', '-d', 'pazario_db',
             '-Fc', '--table=orders', '--table=order_items'],
            stdout=backup, stderr=subprocess.PIPE, check=True, timeout=180)
    sql = build_sql(plan)
    with (folder / 'transaction.sql').open('x') as journal:
        journal.write(sql)
        journal.flush()
        os.fsync(journal.fileno())
    result = subprocess.run(
        ['docker', 'exec', '-i', AUDIT.CONTAINER, 'psql', '-X', '-qAt', '-v',
         'ON_ERROR_STOP=1', '-U', 'pazario', '-d', 'pazario_db'],
        input=sql, capture_output=True, text=True, check=True, timeout=120)
    applied = json.loads(result.stdout, parse_float=Decimal)
    secure_json(folder / 'applied.json', applied)
    after = AUDIT.current_items()
    errors = verify(before, after, applied['changes'])
    secure_json(folder / 'verification.json', {'errors': errors, 'after': after})
    print(json.dumps({
        'mode': 'APPLIED', 'restoredItems': applied['restoredItems'],
        'restoredFields': applied['restoredFields'],
        'skippedFields': len(plan) - applied['restoredFields'],
        'verificationErrors': len(errors), 'journalDirectory': str(folder),
    }), flush=True)
    if errors:
        raise RuntimeError('Post-recovery verification requires review; do not repeat the recovery')


if __name__ == '__main__':
    main()
