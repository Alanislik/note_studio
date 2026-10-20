import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import make_server


class StorageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.start()

    def start(self):
        self.server = make_server(port=0, data_dir=self.temp.name)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def stop(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def tearDown(self):
        self.stop(); self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port)
        conn.request(method, path, body, headers or {})
        response = conn.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        conn.close()
        return result

    def piece(self):
        piece = {'id': 'test-piece', 'title': 'Example', 'xml': '<score-partwise/>',
                 'effects': {'color': '#00ffaa', 'glow': True, 'pulse': True}, 'media': []}
        result = self.request('PUT', '/api/pieces/test-piece', json.dumps(piece))
        self.assertEqual(result[0], 200)
        return piece

    def test_original_media_and_settings_survive_server_restart(self):
        piece = self.piece()
        status, _, body = self.request('POST', '/api/pieces/test-piece/files?name=original.musicxml', b'<score-partwise/>')
        self.assertEqual(status, 201)
        original = json.loads(body)
        status, _, body = self.request('POST', '/api/pieces/test-piece/files?name=clip.mp4', b'0123456789')
        self.assertEqual(status, 201)
        media = json.loads(body)
        piece.update(originalFile=original, media=[dict(media, sync=True, start=2, end=4)])
        self.assertEqual(self.request('PUT', '/api/pieces/test-piece', json.dumps(piece))[0], 200)
        self.stop(); self.start()
        self.assertEqual(json.loads(self.request('GET', '/api/pieces')[2]), [piece])
        self.assertEqual(self.request('GET', original['url'])[2], b'<score-partwise/>')
        status, headers, body = self.request('GET', media['url'], headers={'Range': 'bytes=3-6'})
        self.assertEqual((status, body, headers['Content-Range']), (206, b'3456', 'bytes 3-6/10'))
        self.assertEqual(self.request('GET', media['url'], headers={'Range': 'bytes=-3'})[2], b'789')
        self.assertEqual(self.request('GET', media['url'], headers={'Range': 'bytes=50-'})[0], 416)
        self.assertEqual(self.request('GET', original['url']+'?download=1')[1]['Content-Disposition'].split(';')[0], 'attachment')
        self.assertEqual(self.request('DELETE', '/api/pieces/test-piece')[0], 200)
        self.assertEqual(json.loads(self.request('GET', '/api/pieces')[2]), [])
        self.assertEqual(self.request('GET', original['url'])[0], 404)
        self.assertEqual(list(Path(self.temp.name).rglob('*.musicxml')), [])
        self.assertEqual(list(Path(self.temp.name).rglob('*.mp4')), [])

    def test_rejects_unsupported_files_and_hides_private_directories(self):
        self.piece()
        self.assertEqual(self.request('POST', '/api/pieces/test-piece/files?name=bad.html', b'<script/>')[0], 400)
        self.assertEqual(self.request('PUT', '/api/pieces/wrong', '{broken')[0], 400)
        self.assertEqual(self.request('GET', '/data/library.sqlite3')[0], 404)
        self.assertEqual(self.request('GET', '/.git/config')[0], 404)
        self.assertEqual(self.request('PUT', '/api/pieces/test-piece', '{}', {'Origin': 'https://other.example'})[0], 403)
        self.assertEqual(self.request('POST', '/api/pieces/test-piece/files?name=big.mp4', b'', {'Content-Length': str(101*1024*1024)})[0], 400)

    def test_delete_individual_attachment_preserves_score(self):
        self.piece()
        status, _, body = self.request('POST', '/api/pieces/test-piece/files?name=cover.png', b'png-data')
        self.assertEqual(status, 201)
        file = json.loads(body)
        self.assertEqual(self.request('DELETE', file['url'])[0], 200)
        self.assertEqual(self.request('GET', file['url'])[0], 404)
        self.assertEqual(len(json.loads(self.request('GET', '/api/pieces')[2])), 1)


if __name__ == '__main__':
    unittest.main()
