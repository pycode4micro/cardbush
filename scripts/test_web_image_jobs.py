"""Image task receipt regression using a local fake provider, with no network calls."""
import asyncio
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/web/plugins/volcengine_images'))
from volcengine_plugins.image_jobs import ImageJobs, account_scope
from volcengine_plugins.models import DEFAULT_MODEL, ImageRequest, LocalOptions


class ImageJobReceiptTests(unittest.IsolatedAsyncioTestCase):
    async def test_receipts_keep_task_identity_and_complete_once_without_action_hints(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            class FakeClient:
                api_key = 'fixture-key'
                base_url = 'https://fixture.invalid'
                output_dir = root
                calls = 0

                def __init__(self):
                    self.started = asyncio.Event()
                    self.release = asyncio.Event()

                async def generate_prepared(self, body, warnings, options):
                    self.calls += 1
                    self.started.set()
                    await self.release.wait()
                    return {'data': [{'local_path': str(root / 'result.png')}]}

            client = FakeClient()
            jobs = ImageJobs(root / 'jobs')
            request = ImageRequest(prompt='Fixture image', model=DEFAULT_MODEL)
            options = LocalOptions(save_images=False)
            try:
                first = await jobs.create(client, request, options, 'fixture-request')
                self.assertEqual(set(first), {'task', 'paid_request_sent', 'automatic_retry', 'reused'})
                self.assertEqual(first['task']['status'], 'queued')
                self.assertFalse(first['paid_request_sent'])
                self.assertFalse(first['automatic_retry'])
                self.assertFalse(first['reused'])
                duplicate = await jobs.create(client, request, options, 'fixture-request')
                self.assertEqual(duplicate['task']['id'], first['task']['id'])
                self.assertTrue(duplicate['reused'])
                await asyncio.wait_for(client.started.wait(), timeout=2)
                running = jobs.get(first['task']['id'], account_scope(client))
                self.assertEqual(running['task']['status'], 'running')
                client.release.set()
                await asyncio.wait_for(asyncio.gather(*tuple(jobs.workers)), timeout=2)
                completed = await jobs.create(client, request, options, 'fixture-request')
                self.assertEqual(set(completed), set(first))
                self.assertEqual(completed['task']['id'], first['task']['id'])
                self.assertEqual(completed['task']['status'], 'succeeded')
                self.assertEqual(completed['task']['result']['data'][0]['local_path'], str(root / 'result.png'))
                self.assertTrue(completed['paid_request_sent'])
                self.assertTrue(completed['reused'])
                self.assertEqual(client.calls, 1)
            finally:
                await jobs.close()


if __name__ == '__main__':
    unittest.main()
