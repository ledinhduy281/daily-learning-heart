import json
import socket
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

    def test_head_matches_get_headers_without_writing_a_body(self):
        def request(method, path):
            with socket.create_connection(self.server.server_address, timeout=5) as connection:
                connection.sendall(f'{method} {path} HTTP/1.0\r\n\r\n'.encode('ascii'))
                with connection.makefile('rb') as stream:
                    response = stream.read()
            headers, body = response.split(b'\r\n\r\n', 1)
            status, *headers = headers.split(b'\r\n')
            headers = dict(header.split(b': ', 1) for header in headers)
            headers.pop(b'Date')
            return int(status.split()[1]), headers, body

        for path, expected_status in (('/', 200), ('/index.html', 200), ('/fetch_daily_ebm.py', 403)):
            with self.subTest(path=path):
                get_status, get_headers, get_body = request('GET', path)
                head_status, head_headers, head_body = request('HEAD', path)
                self.assertEqual(get_status, expected_status)
                self.assertEqual(head_status, get_status)
                self.assertEqual(head_headers, get_headers)
                self.assertEqual(head_headers[b'Content-Length'], str(len(get_body)).encode('ascii'))
                self.assertEqual(head_body, b'')
                if expected_status == 200:
                    self.assertIn(b'<script>window.EBM_SERVER = true;</script>', get_body)
                else:
                    self.assertEqual(json.loads(get_body)['error'], 'Private data')

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

    def test_feedback_reports_are_private_even_with_a_configured_legacy_username(self):
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
            self.request('/api/feedback', body={'briefing_id': 'private-report', 'type': 'report', 'comment': 'Guest report'})
            self.assertEqual(self.request('/api/feedback')[1]['recent_reports'], [])
            _, guest = self.request('/api/auth/register', body={'username': 'guest', 'password': 'test-password'})
            self.assertEqual(self.request('/api/feedback', headers={'Authorization': 'Bearer ' + guest['token']})[1]['recent_reports'], [])
            self.request('/api/feedback', body={'briefing_id': 'private-report', 'type': 'report', 'comment': 'Own report'}, headers=headers)
            payload = self.request('/api/feedback', headers=headers)[1]
            self.assertEqual(payload['summary']['private-report']['report'], 3)
            self.assertEqual([r['comment'] for r in payload['recent_reports']], ['Own report'])
            reports = self.request('/api/feedback', device)[1]['recent_reports']
            self.assertTrue(any(r['id'] == stored['id'] for r in reports))
            self.assertTrue(any(r['id'] == 'legacy' for r in reports))
            self.assertNotRegex(json.dumps(reports), device + '|hidden|username|token|email')
        self.assertEqual(self.request('/api/feedback', str(uuid.uuid4()))[1]['recent_reports'], [])

    def test_authenticated_guest_can_read_only_its_unambiguous_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            users = Path(directory) / 'users.json'
            feedback = Path(directory) / 'feedback.json'
            with patch.object(app, 'USERS_PATH', users), patch.object(app, 'FEEDBACK_PATH', feedback):
                briefing_id = 'guest-report'
                legacy = {'briefing_id': briefing_id, 'comment': 'Historical ambiguous report'}
                feedback.write_text(json.dumps({'votes': {}, 'reports': [
                    {**legacy, 'username': 'guest'},
                    {**legacy, 'author_id': app._feedback_author_id('guest')},
                ]}))
                status, guest = self.request('/api/auth/register', body={'username': 'guest', 'password': 'test-password'})
                self.assertEqual(status, 200)
                headers = {'Authorization': 'Bearer ' + guest['token']}
                report = {'briefing_id': briefing_id, 'type': 'report'}
                self.assertEqual(self.request('/api/feedback', body={**report, 'comment': 'Anonymous'})[0], 200)
                self.assertEqual(self.request('/api/feedback', body={**report, 'comment': 'Signed in'}, headers=headers)[0], 200)

                _, payload = self.request('/api/feedback', headers=headers)
                self.assertEqual([r['comment'] for r in payload['recent_reports']], ['Signed in'])
                self.assertNotEqual(payload['recent_reports'][0]['author_id'], app._feedback_author_id('guest'))
                self.assertEqual(payload['summary'][briefing_id]['report'], 4)
                self.assertEqual(self.request('/api/feedback')[1]['recent_reports'], [])
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

    def test_retired_password_reset_cannot_issue_a_session_or_change_passwords(self):
        username, email = 'reset-owner', 'reset-owner@example.com'
        original_password = 'original-test-password'
        status, owner = self.request('/api/auth/register', body={
            'username': username, 'email': email, 'password': original_password,
        })
        self.assertEqual(status, 200)
        before = self.users.read_bytes()
        device = str(uuid.uuid4())
        for identifier, value, device_id, headers in (
            ('username', username, None, None),
            ('email', email, None, {'Authorization': 'Bearer invalid-test-token'}),
            ('username', username, device, None),
            ('email', email, None, {'Authorization': 'Bearer ' + owner['token']}),
        ):
            with self.subTest(identifier=identifier, device=bool(device_id), signed_in=bool(headers)):
                status, payload = self.request('/api/auth/reset-password', device_id, {
                    identifier: value, 'new_password': 'replacement-test-password',
                }, headers)
                self.assertEqual(status, 410)
                self.assertFalse(payload['ok'])
                self.assertNotIn('token', payload)
        self.assertEqual(self.users.read_bytes(), before)
        self.assertEqual(self.request('/api/auth/login', body={'username': username, 'password': 'replacement-test-password'})[0], 401)
        self.assertEqual(self.request('/api/auth/login', body={'username': username, 'password': original_password})[0], 200)

        activity = {'action': 'sync', 'read_ids': ['reset-lesson'], 'bookmarked_ids': ['reset-lesson'], 'display_name': 'Device user'}
        self.assertEqual(self.request('/api/user/activity', device, activity)[0], 200)
        self.assertEqual(self.request('/api/status', device)[1]['user']['bookmarked_ids'], ['reset-lesson'])
        self.assertEqual(self.request('/api/status', str(uuid.uuid4()))[1]['user']['bookmarked_ids'], [])

    def test_retired_demo_cannot_sign_in_or_use_an_old_session(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(app, 'USERS_PATH', Path(directory) / 'users.json'):
            username, email = 'bs.timmach', 'demo@example.com'
            password = 'demo-fixture-password'
            status, payload = self.request('/api/auth/login', body={'demo': True})
            self.assertEqual(status, 410)
            self.assertNotIn('token', payload)
            self.assertEqual(self.request('/api/auth/register', body={'username': username, 'password': password})[0], 409)
            data = json.loads(app.USERS_PATH.read_text())
            self.assertNotIn(username, data['users'])

            with app._users_lock:
                salt, password_hash = app._hash_password(password)
                demo = {'username': username, 'email': email, 'salt': salt, 'password_hash': password_hash}
                data['users'][username] = demo
                token = app._create_session_for_user(data, demo)
                app._save_users_data_unlocked(data)

            for identifier in (username, email):
                with self.subTest(identifier=identifier):
                    status, payload = self.request('/api/auth/login', body={'username': identifier, 'password': password})
                    self.assertEqual(status, 401)
                    self.assertNotIn('token', payload)
            headers = {'Authorization': 'Bearer ' + token}
            self.assertEqual(self.request('/api/auth/me', headers=headers)[0], 401)

    def test_legacy_session_stays_bound_to_its_account_when_an_email_changes(self):
        status, first = self.request('/api/auth/register', body={'username': 'alias-owner', 'password': 'first-test-password'})
        self.assertEqual(status, 200)
        username = 'MixedCase@example.com'
        status, second = self.request('/api/auth/register', body={'username': username, 'password': 'second-test-password'})
        self.assertEqual(status, 200)
        first_headers = {'Authorization': 'Bearer ' + first['token']}
        self.assertEqual(self.request('/api/auth/profile', body={'email': username}, headers=first_headers)[0], 200)
        second_headers = {'Authorization': 'Bearer ' + second['token']}
        status, payload = self.request('/api/auth/me', headers=second_headers)
        self.assertEqual(status, 200)
        self.assertEqual(payload['user']['username'], username)

    def test_demo_retirement_preserves_legacy_account_with_similar_username(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(app, 'USERS_PATH', Path(directory) / 'users.json'):
            username, email = 'bs. timmach', 'legacy-owner@example.com'
            password = 'legacy-owner-password'
            with app._users_lock:
                data = app._load_users_data_unlocked()
                salt, password_hash = app._hash_password(password)
                user = {'username': username, 'email': email, 'salt': salt, 'password_hash': password_hash}
                data['users'][username] = user
                existing_token = app._create_session_for_user(data, user)
                app._save_users_data_unlocked(data)

            status, payload = self.request('/api/auth/login', body={'email': email, 'password': password})
            self.assertEqual(status, 200)
            self.assertEqual(payload['user']['username'], username)
            for token in (existing_token, payload['token']):
                status, session = self.request('/api/auth/me', headers={'Authorization': 'Bearer ' + token})
                self.assertEqual(status, 200)
                self.assertEqual(session['user']['username'], username)


if __name__ == '__main__':
    unittest.main()
