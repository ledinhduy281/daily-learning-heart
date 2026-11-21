import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from unittest.mock import patch

import fetch_daily_ebm as app


class QuietHandler(app.EBMRequestHandler):
    def log_message(self, *args):
        pass


class DeviceProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.users = Path(cls.directory.name) / 'users.json'
        cls.feedback = Path(cls.directory.name) / 'feedback.json'
        cls.patches = [patch.object(app, 'USERS_PATH', cls.users), patch.object(app, 'FEEDBACK_PATH', cls.feedback)]
        for p in cls.patches:
            p.start()
        cls.server = app.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        for p in reversed(cls.patches):
            p.stop()
        cls.directory.cleanup()

    def request(self, path, device=None, body=None, headers=None):
        headers = dict(headers or {})
        if device is not None:
            headers['X-Device-Id'] = device
        if body is not None:
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            res = urllib.request.urlopen(req)
        except urllib.error.HTTPError as error:
            res = error
        with res:
            return res.status, json.loads(res.read())

    def test_device_activity_no_registration_and_isolation(self):
        device, other = str(uuid.uuid4()), str(uuid.uuid4())
        status, data = self.request('/api/user/activity', device.upper(), {'action': 'read', 'briefing_id': 'lesson-1'})
        self.assertEqual(status, 200)
        self.assertEqual(data['user']['username'], 'device:' + device)
        self.request('/api/user/activity', device, {'action': 'toggle_bookmark', 'briefing_id': 'lesson-1'})
        _, state = self.request('/api/status', device)
        self.assertEqual(state['user']['read_ids'], ['lesson-1'])
        self.assertEqual(state['user']['bookmarked_ids'], ['lesson-1'])
        _, state = self.request('/api/status', other)
        self.assertEqual(state['user']['read_ids'], [])
        saved = json.loads(self.users.read_text())
        self.assertNotIn('password_hash', saved['devices'][device])
        self.assertEqual(saved['devices'][device]['read_ids'], ['lesson-1'])

    def test_invalid_ids_ignored_and_empty_requests(self):
        for device in ('not-a-uuid', '../users', 'a' * 32, ''):
            self.assertEqual(self.request('/api/user/activity', device, {'action': 'read', 'briefing_id': 'lesson'})[0], 401)
            self.assertIsNone(self.request('/api/status', device)[1]['user'])
        self.assertEqual(self.request('/api/user/activity', str(uuid.uuid4()), {})[0], 400)

    def test_feedback_saved_per_device(self):
        one, two = str(uuid.uuid4()), str(uuid.uuid4())
        for device in (one, two):
            self.assertEqual(self.request('/api/feedback', device, {'briefing_id': 'feedback-lesson', 'type': 'like'})[0], 200)
        self.request('/api/feedback', one, {'briefing_id': 'feedback-lesson', 'type': 'report', 'comment': 'Review endpoint'})
        _, first = self.request('/api/feedback', one)
        _, second = self.request('/api/feedback', two)
        self.assertEqual(first['summary']['feedback-lesson']['like'], 2)
        self.assertEqual(first['summary']['feedback-lesson']['user_vote'], 'like')
        self.assertEqual(len(first['recent_reports']), 1)
        self.assertEqual(second['recent_reports'], [])
        stored = json.loads(self.feedback.read_text())
        self.assertIn('device:' + one, stored['votes']['feedback-lesson'])

    def test_sync_and_quiz_persistence(self):
        device = str(uuid.uuid4())
        body = {'action': 'sync', 'read_ids': ['one', 'one'], 'bookmarked_ids': ['two'], 'display_name': 'Doctor A'}
        status, result = self.request('/api/user/activity', device, body)
        self.assertEqual(status, 200)
        self.assertEqual(result['user']['read_ids'], ['one'])
        self.assertEqual(result['user']['display_name'], 'Doctor A')
        self.assertEqual(self.request('/api/user/activity', device, {**body, 'read_ids': 'bad'})[0], 400)
        self.assertEqual(self.request('/api/user/activity', device, {**body, 'read_ids': [None]})[0], 400)
        with patch.object(app, 'handle_socratic_turn', return_value={'ok': True, 'state': {'correct_count': 3}}):
            self.assertEqual(self.request('/api/socratic', device, {'briefing_id': 'one'})[0], 200)
        stored = json.loads(self.users.read_text())
        self.assertEqual(stored['devices'][device]['socratic_state']['one']['correct_count'], 3)

    def test_legacy_auth_and_unblocked_page(self):
        status, login = self.request('/api/auth/register', body={'username': 'legacy-doctor', 'password': 'test-password'})
        self.assertEqual(status, 200)
        status, user = self.request('/api/auth/me', str(uuid.uuid4()), headers={'Authorization': 'Bearer ' + login['token']})
        self.assertEqual(status, 200)
        self.assertEqual(user['user']['username'], 'legacy-doctor')
        with urllib.request.urlopen(self.base + '/') as response:
            page = response.read().decode()
        self.assertIn('window.EBM_SERVER = true', page)
        self.assertNotIn('authGateOverlay', page)
        self.assertNotIn('type="password"', page)
        request = urllib.request.Request(self.base + '/', method='OPTIONS')
        with urllib.request.urlopen(request) as response:
            self.assertIn('X-Device-Id', response.headers['Access-Control-Allow-Headers'])
        with patch.object(app, 'USERS_PATH', app.BASE_DIR / 'data' / 'users.json'):
            self.assertEqual(self.request('/data/users.json')[0], 403)


if __name__ == '__main__':
    unittest.main()
