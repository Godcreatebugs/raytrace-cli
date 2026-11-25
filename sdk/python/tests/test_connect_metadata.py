"""Failed GitHub setup preserves the API error's actionable metadata."""
import unittest

from raytrace_sdk import RayTrace, RayTraceError


class ConnectMetadataTests(unittest.TestCase):
    def test_api_errors_keep_their_code_and_topup_url(self):
        for stage in ('repos', 'commands'):
            with self.subTest(stage=stage):
                failure = {'error': 'Insufficient balance', 'code': 'insufficient_balance',
                           'topup_url': 'https://example.test/top-up'}

                def transport(method, url, headers, body):
                    if (method, url) == ('POST', 'https://api.test/v1/sandboxes'):
                        return 201, {'id': 'rtp-created', 'status': 'running'}
                    if url.endswith('/' + stage):
                        return 402, failure
                    if url.endswith('/repos'):
                        return 200, {'repos': ['acme/app']}
                    self.fail(f'Unexpected request: {method} {url}')

                client = RayTrace(api_key='test', base_url='https://api.test', transport=transport)
                with self.assertRaises(RayTraceError) as caught:
                    client.sandboxes.create(files={'app.py': 'print(1)'}, repo='acme/app', connect=True)
                error = caught.exception
                self.assertEqual(error.code, failure['code'])
                self.assertEqual(error.topup_url, failure['topup_url'])
                self.assertEqual(error.status, 402)
                self.assertEqual(error.body, failure)
                self.assertIsInstance(error.__cause__, RayTraceError)
                self.assertEqual(error.sandbox.id, 'rtp-created')
                self.assertIn('was created', str(error))


if __name__ == '__main__':
    unittest.main()
