import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('recover-finance-20260830.py'))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    def fixture(self):
        row = {'id': 'item', 'orderId': 'order', 'marketplace': 'HEPSIBURADA',
               'sku': 'SKU', 'marketplaceProductId': 'ext', 'manualPurchasePrice': None,
               'shippingFee': 0, 'serviceFee': 0, 'extraFees': 0}
        candidate = {'itemId': 'item', 'orderId': 'order', 'marketplace': 'HEPSIBURADA',
                     'rowWasRecreated': True, 'changes': {
                         'manualPurchasePrice': {'backup': '12.50', 'current': None, 'currentlyEmpty': True},
                         'shippingFee': {'backup': '5.00', 'current': '0.00', 'currentlyEmpty': True}}}
        return row, candidate

    def test_only_empty_fields(self):
        row, candidate = self.fixture()
        row['manualPurchasePrice'] = 0
        plan = recovery.make_plan({'candidatesForReview': [candidate]}, [row])
        self.assertEqual([p['field'] for p in plan], ['shippingFee'])

    def test_preserves_new_nonzero_fees(self):
        row, candidate = self.fixture()
        row['shippingFee'] = 9
        plan = recovery.make_plan({'candidatesForReview': [candidate]}, [row])
        self.assertEqual([p['field'] for p in plan], ['manualPurchasePrice'])

    def test_limits_marketplace_and_recreated_rows(self):
        row, candidate = self.fixture()
        candidate['marketplace'] = 'N11'
        self.assertEqual(recovery.make_plan({'candidatesForReview': [candidate]}, [row]), [])
        candidate['marketplace'] = 'HEPSIBURADA'
        candidate['rowWasRecreated'] = False
        self.assertEqual(recovery.make_plan({'candidatesForReview': [candidate]}, [row]), [])

    def test_duplicate_targets_rejected(self):
        row, candidate = self.fixture()
        with self.assertRaises(ValueError):
            recovery.make_plan({'candidatesForReview': [candidate, candidate]}, [row])

    def test_sql_guards_current_values_and_never_deletes(self):
        row, candidate = self.fixture()
        plan = recovery.make_plan({'candidatesForReview': [candidate]}, [row])
        sql = recovery.build_sql(plan)
        self.assertIn('FOR UPDATE', sql)
        self.assertIn('IS NOT DISTINCT FROM p.expected', sql)
        self.assertIn('i."manualPurchasePrice" IS NULL', sql)
        self.assertIn('i."shippingFee" = 0', sql)
        self.assertNotIn('DELETE', sql)
        self.assertIn('COMMIT;', sql)

    def test_verification_checks_untouched_fields_too(self):
        row, _ = self.fixture()
        after = {**row, 'manualPurchasePrice': 12.5}
        changes = [{'itemId': 'item', 'field': 'manualPurchasePrice', 'after': 12.5}]
        self.assertEqual(recovery.verify([row], [after], changes), [])
        after['serviceFee'] = 100
        self.assertEqual(len(recovery.verify([row], [after], changes)), 1)


if __name__ == '__main__':
    unittest.main()
