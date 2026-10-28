"""Read-only comparison of PostgreSQL dumps and current financial item fields.

Run on the database host. Dumps are decoded in memory, never restored to the live DB.
Only order/item identifiers and financial differences are emitted, not customer data.
"""
import argparse
import csv
import json
import re
import subprocess
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path

FIELDS = ('manualPurchasePrice', 'shippingFee', 'serviceFee', 'extraFees')
CONTAINER = 'pazario-deploy-postgres-1'


def copy_value(value):
    if value == r'\N':
        return None
    escapes = {'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t', 'v': '\v'}

    def replace(match):
        token = match.group(1)
        if token[0] in '01234567':
            return chr(int(token, 8))
        if token.startswith('x') and len(token) > 1:
            return chr(int(token[1:], 16))
        return escapes.get(token, token)

    return re.sub(r'\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)', replace, value)


def read_dump(path):
    with Path(path).open('rb') as source:
        result = subprocess.run(
            ['docker', 'exec', '-i', CONTAINER, 'pg_restore', '--file=-', '--data-only',
             '--table=orders', '--table=order_items'],
            stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=True, encoding='utf-8', timeout=180,
        )
    tables = {'orders': [], 'order_items': []}
    table = None
    columns = []
    for line in result.stdout.splitlines():
        match = re.match(r'COPY public\.(orders|order_items) \((.+)\) FROM stdin;', line)
        if match:
            table = match.group(1)
            columns = next(csv.reader([match.group(2)], skipinitialspace=True))
        elif line == r'\.':
            table = None
        elif table:
            values = line.split('\t')
            if len(values) != len(columns):
                raise ValueError('Invalid COPY row; audit stopped')
            tables[table].append(dict(zip(columns, map(copy_value, values))))
    if not tables['orders']:
        raise ValueError('No order rows in dump; audit stopped')
    return tables


def amount(row, field):
    value = row.get(field)
    return None if value is None else Decimal(str(value))


def meaningful(row, field):
    value = amount(row, field)
    return value is not None if field == 'manualPurchasePrice' else value not in (None, 0)


def current_items():
    query = '''BEGIN READ ONLY;
SELECT coalesce(json_agg(t), '[]'::json) FROM (
 SELECT i.*, o.marketplace, o."marketplaceOrderNo", o."marketplaceOrderId"
 FROM order_items i JOIN orders o ON o.id=i."orderId"
) t;
COMMIT;'''
    result = subprocess.run(
        ['docker', 'exec', '-i', CONTAINER, 'psql', '-X', '-qAt', '-v',
         'ON_ERROR_STOP=1', '-U', 'pazario', '-d', 'pazario_db'],
        input=query, capture_output=True, text=True, check=True, timeout=60,
    )
    return json.loads(result.stdout, parse_float=Decimal)


def compare(path, current):
    tables = read_dump(path)
    orders = {row['id']: row for row in tables['orders']}
    by_order = defaultdict(list)
    for item in current:
        by_order[item['orderId']].append(item)
    candidates = []
    ambiguous = 0
    matched = 0
    for old in tables['order_items']:
        if not any(meaningful(old, field) for field in FIELDS):
            continue
        rows = by_order[old['orderId']]
        sku, external = old.get('sku'), old.get('marketplaceProductId')
        if sku:
            rows = [row for row in rows if row.get('sku') == sku]
            if len(rows) > 1 and external:
                rows = [row for row in rows if row.get('marketplaceProductId') == external]
        elif external:
            rows = [row for row in rows if row.get('marketplaceProductId') == external]
        else:
            rows = [row for row in rows if row['id'] == old['id']]
        if len(rows) != 1:
            ambiguous += 1
            continue
        matched += 1
        new = rows[0]
        changes = {}
        for field in FIELDS:
            if meaningful(old, field) and amount(old, field) != amount(new, field):
                changes[field] = {
                    'backup': str(amount(old, field)),
                    'current': None if amount(new, field) is None else str(amount(new, field)),
                    'currentlyEmpty': not meaningful(new, field),
                }
        if changes:
            order = orders[old['orderId']]
            candidates.append({
                'orderId': old['orderId'], 'itemId': new['id'], 'oldItemId': old['id'],
                'rowWasRecreated': new['id'] != old['id'],
                'marketplace': order['marketplace'],
                'orderNo': order.get('marketplaceOrderNo') or order['marketplaceOrderId'],
                'sku': sku, 'changes': changes,
            })
    return {
        'backup': str(path), 'backupItems': len(tables['order_items']),
        'backupFieldsPresent': {field: sum(meaningful(row, field) for row in tables['order_items']) for field in FIELDS},
        'matchedFinancialItems': matched, 'unmatchedOrAmbiguousFinancialItems': ambiguous,
        'differentItems': len(candidates),
        'differentItemsByMarketplace': dict(Counter(row['marketplace'] for row in candidates)),
        'candidatesForReview': candidates,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backups', nargs='+')
    parser.add_argument('--summary', action='store_true')
    args = parser.parse_args()
    current = current_items()
    for path in args.backups:
        report = compare(path, current)
        if args.summary:
            candidates = report.pop('candidatesForReview')
            report['recreatedRowsWithDifferentFinance'] = sum(row['rowWasRecreated'] for row in candidates)
            report['currentlyEmptyFieldsWithBackupValue'] = sum(
                change['currentlyEmpty'] for row in candidates for change in row['changes'].values())
        print(json.dumps(report, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
