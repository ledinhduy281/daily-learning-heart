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
    def test_empty_sync_and_expired_device_capacity(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(app, 'USERS_PATH', Path(directory) / 'users.json'), patch.object(app, 'MAX_ANONYMOUS_DEVICES', 1):
            one, two = str(uuid.uuid4()), str(uuid.uuid4())
            empty = {'action': 'sync', 'read_ids': [], 'bookmarked_ids': [], 'display_name': 'Doctor'}
            self.assertEqual(self.request('/api/user/activity', one, empty)[0], 200)
            self.assertFalse(json.loads(app.USERS_PATH.read_text()).get('devices'))
            self.assertEqual(self.request('/api/user/activity', one, {**empty, 'display_name': 'Chosen name'})[0], 200)
            data = json.loads(app.USERS_PATH.read_text())
            self.assertIn('updated_at', data['devices'][one])
            data['devices'][one]['created_at'] = '2000-01-01T00:00:00+00:00'
            app._save_users_data_unlocked(data)
            self.assertEqual(self.request('/api/user/activity', two, {'action': 'read', 'briefing_id': 'new'})[0], 429)
            data['devices'][one]['updated_at'] = '2000-01-01T00:00:00+00:00'
            app._save_users_data_unlocked(data)
            self.request('/api/status', one)
            self.assertEqual(json.loads(app.USERS_PATH.read_text())['devices'][one]['updated_at'], '2000-01-01T00:00:00+00:00')
            self.assertEqual(self.request('/api/user/activity', two, {'action': 'read', 'briefing_id': 'new'})[0], 200)
            devices = json.loads(app.USERS_PATH.read_text())['devices']
            self.assertEqual(list(devices), [two])
            self.assertEqual(devices[two]['read_ids'], ['new'])
            self.assertEqual(self.request('/api/user/activity', two, empty)[0], 200)
            self.assertEqual(json.loads(app.USERS_PATH.read_text())['devices'][two]['read_ids'], [])

    def test_static_assets_exclude_private_stores_and_atomic_temps(self):
        original_replace = app.os.replace
        checked = []
        with tempfile.TemporaryDirectory(dir=app.DATA_DIR) as directory:
            def check_temp(source, destination):
                relative = Path(source).relative_to(app.BASE_DIR).as_posix()
                self.assertTrue(Path(source).exists())
                self.assertEqual(self.request('/' + relative)[0], 403)
                checked.append(relative)
                original_replace(source, destination)
            for name in ('users.json', 'feedback.json'):
                path = Path(directory) / name
                with patch.object(app.os, 'replace', side_effect=check_temp):
                    app._atomic_write_text(path, '{"private":true}')
                self.assertEqual(self.request('/' + path.relative_to(app.BASE_DIR).as_posix())[0], 403)
        self.assertEqual(len(checked), 2)
        for path in ('/.env', '/fetch_daily_ebm.py', '/data/', '/data/users.json.1.2.tmp', '/data/feedback.json', '/data/%75sers.json'):
            self.assertEqual(self.request(path)[0], 403)
        with urllib.request.urlopen(self.base + '/device_profile.js') as response:
            self.assertEqual(response.status, 200)

    def test_anonymous_storage_is_write_only_and_bounded(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(app, 'USERS_PATH', Path(directory) / 'users.json'), patch.object(app, 'FEEDBACK_PATH', Path(directory) / 'feedback.json'), patch.object(app, 'MAX_ANONYMOUS_DEVICES', 1):
            one, two = str(uuid.uuid4()), str(uuid.uuid4())
            for device in (one, two):
                self.assertEqual(self.request('/api/status', device)[0], 200)
                self.assertEqual(self.request('/api/feedback', device)[0], 200)
            self.assertFalse(json.loads(app.USERS_PATH.read_text()).get('devices'))
            self.assertEqual(self.request('/api/user/activity', one, {'action': 'read', 'briefing_id': 'one'})[0], 200)
            self.assertEqual(self.request('/api/user/activity', two, {'action': 'read', 'briefing_id': 'two'})[0], 429)
            self.assertEqual(self.request('/api/feedback', two, {'type': 'like', 'briefing_id': 'two'})[0], 429)
            with patch.object(app, 'handle_socratic_turn', return_value={'ok': True, 'state': {}}):
                self.assertEqual(self.request('/api/socratic', two, {})[0], 429)
            before = app.USERS_PATH.read_text()
            with patch.object(app, 'MAX_DEVICE_BYTES', 600):
                self.assertEqual(self.request('/api/user/activity', one, {'action': 'read', 'briefing_id': 'x' * 450})[0], 413)
                with patch.object(app, 'handle_socratic_turn', return_value={'ok': True, 'state': {'text': 'x' * 700}}):
                    self.assertEqual(self.request('/api/socratic', one, {})[0], 413)
            self.assertEqual(app.USERS_PATH.read_text(), before)
            self.assertEqual(self.request('/api/user/activity', one, {'action':'read', 'briefing_id':'x' * app.MAX_DEVICE_BYTES})[0], 413)

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

    def test_feedback_authors_are_not_credentials_and_moderators_are_provisioned(self):
        device = str(uuid.uuid4())
        self.request('/api/feedback', device, {'briefing_id': 'private-report', 'type': 'report', 'comment': 'Check source'})
        own = self.request('/api/feedback', device)[1]['recent_reports']
        self.assertEqual(len(own), 1)
        self.assertNotIn(device, json.dumps(own))
        stored = json.loads(self.feedback.read_text())['reports'][-1]
        self.assertNotIn('username', stored)
        self.assertEqual(stored['author_id'], app._feedback_author_id('device:' + device))
        status, login = self.request('/api/auth/register', body={'username': 'admin', 'password': 'test-password'})
        self.assertEqual(status, 200)
        headers = {'Authorization': 'Bearer ' + login['token']}
        with patch.dict(app.os.environ, {'EBM_FEEDBACK_MODERATORS': ''}):
            self.assertEqual(self.request('/api/feedback', headers=headers)[1]['recent_reports'], [])
        with app._feedback_lock:
            data = app._load_feedback_data_unlocked()
            data['reports'].append({'id': 'legacy', 'username': 'device:' + device, 'token': 'hidden', 'email': 'hidden@example.com', 'comment': 'Old report'})
            app._save_feedback_data_unlocked(data)
        with patch.dict(app.os.environ, {'EBM_FEEDBACK_MODERATORS': 'admin'}):
            reports = self.request('/api/feedback', headers=headers)[1]['recent_reports']
            self.assertTrue(any(r['id'] == stored['id'] for r in reports))
            self.assertNotRegex(json.dumps(reports), device + '|hidden|username|token|email')
        self.assertEqual(self.request('/api/feedback', str(uuid.uuid4()))[1]['recent_reports'], [])

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
