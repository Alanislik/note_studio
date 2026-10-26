#!/usr/bin/env python3
"""Local Nota Studio server. No external Python dependencies."""
import argparse
import json
import mimetypes
import re
import sqlite3
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

ROOT = Path(__file__).resolve().parent
SCORE_EXTENSIONS = {'.xml', '.musicxml', '.mxl', '.mid', '.midi'}
MEDIA_TYPES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
               '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg',
               '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
               '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
               '.mov': 'video/quicktime'}
MAX_FILE = 100 * 1024 * 1024
MAX_SCORE = 15 * 1024 * 1024


class Store:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        (self.directory / 'uploads').mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS pieces (id TEXT PRIMARY KEY, document TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS files (
                    id TEXT PRIMARY KEY, piece_id TEXT NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
                    name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL);
            ''')

    def connect(self):
        db = sqlite3.connect(self.directory / 'library.sqlite3', timeout=30)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        return db


class Handler(BaseHTTPRequestHandler):
    def json_response(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def error(self, message, status=400):
        self.json_response({'error': message}, status)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/api/status':
            return self.json_response({'storage': 'folder', 'location': self.server.store.directory.name,
                                       'maxFileBytes': MAX_FILE, 'maxScoreBytes': MAX_SCORE})
        if path == '/api/pieces':
            with self.server.store.connect() as db:
                rows = db.execute('SELECT document FROM pieces').fetchall()
            return self.json_response([json.loads(row['document']) for row in rows])
        match = re.fullmatch(r'/api/files/([a-f0-9-]+)', path)
        if match:
            with self.server.store.connect() as db:
                row = db.execute('SELECT * FROM files WHERE id=?', (match[1],)).fetchone()
            if not row:
                return self.error('Файл не найден.', 404)
            return self.send_file(self.server.store.directory / row['path'], row['type'], row['name'])
        allowed = {'/', '/index.html', '/styles.css', '/app.js', '/audio-engine.js', '/studio.js', '/sunset-preset.js', '/animated-image.js', '/vendor/omggif.js',
                   '/assets/sunset/sunset.jpg', '/assets/sunset/kris.png',
                   '/assets/sunset/susie.png', '/assets/sunset/ralsei.png', '/assets/sunset/sources.json'}
        if path not in allowed:
            return self.error('Не найдено.', 404)
        file = ROOT / ('index.html' if path == '/' else path[1:])
        self.send_file(file, mimetypes.guess_type(file)[0] or 'application/octet-stream')

    def send_file(self, path, mime, name=None):
        if not path.is_file():
            return self.error('Файл не найден.', 404)
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        requested = self.headers.get('Range')
        if requested:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
            if not match or not any(match.groups()) or size == 0:
                return self.range_error(size)
            if match[1]:
                start = int(match[1]); end = min(int(match[2]), size - 1) if match[2] else size - 1
            else:
                start = max(0, size - int(match[2]))
            if start > end or start >= size:
                return self.range_error(size)
            status = 206
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(max(0, end - start + 1)))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-cache')
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        if name:
            disposition = 'attachment' if 'download' in parse_qs(urlsplit(self.path).query) else 'inline'
            self.send_header('Content-Disposition', f"{disposition}; filename*=UTF-8''{quote(name, safe='')}")
        self.end_headers()
        if self.command != 'HEAD':
            try:
                with path.open('rb') as file:
                    file.seek(start)
                    remaining = end - start + 1
                    while remaining > 0:
                        chunk = file.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk); remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def range_error(self, size):
        self.send_response(416)
        self.send_header('Content-Range', f'bytes */{size}')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def read_body(self, limit):
        try:
            length = int(self.headers.get('Content-Length', '-1'))
        except ValueError:
            raise ValueError('Некорректный размер запроса.')
        if not 0 <= length <= limit:
            raise ValueError('Файл или запрос превышает допустимый размер.')
        body = self.rfile.read(length)
        if len(body) != length:
            raise ValueError('Загрузка прервана.')
        return body

    def do_PUT(self):
        self.write_request()

    def do_POST(self):
        self.write_request()

    def do_DELETE(self):
        self.write_request()

    def write_request(self):
        # Writes are same-origin; the default server listens only on loopback.
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc != self.headers.get('Host'):
            return self.error('Запрос с другого сайта запрещён.', 403)
        try:
            return self.mutate()
        except (ValueError, UnicodeError, json.JSONDecodeError) as error:
            return self.error(str(error))
        except (OSError, sqlite3.Error):
            return self.error('Не удалось сохранить данные. Проверьте доступ и свободное место в data.', 500)

    def mutate(self):
        path = urlsplit(self.path).path
        match = re.fullmatch(r'/api/pieces/([A-Za-z0-9_-]{1,100})(/files)?', path)
        if match:
            piece_id = match[1]
            if self.command == 'PUT' and not match[2]:
                document = json.loads(self.read_body(20 * 1024 * 1024))
                if not isinstance(document, dict) or document.get('id') != piece_id:
                    raise ValueError('Некорректное произведение.')
                if not isinstance(document.get('xml'), str) or not isinstance(document.get('title'), str):
                    raise ValueError('Нужны название и ноты MusicXML.')
                with self.server.store.connect() as db:
                    db.execute('INSERT INTO pieces VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document',
                               (piece_id, json.dumps(document, ensure_ascii=False)))
                return self.json_response({'ok': True})
            if self.command == 'POST' and match[2]:
                with self.server.store.connect() as db:
                    if not db.execute('SELECT id FROM pieces WHERE id=?', (piece_id,)).fetchone():
                        return self.error('Сначала сохраните произведение.', 404)
                    name = parse_qs(urlsplit(self.path).query).get('name', [''])[0]
                    name = name.replace('\\', '/').split('/')[-1][:180]
                    extension = Path(name).suffix.lower()
                    if extension not in SCORE_EXTENSIONS | MEDIA_TYPES.keys():
                        raise ValueError('Этот формат файла не поддерживается.')
                    body = self.read_body(MAX_SCORE if extension in SCORE_EXTENSIONS else MAX_FILE)
                    if not body:
                        raise ValueError('Пустой файл.')
                    file_id = str(uuid.uuid4())
                    relative = Path('uploads') / piece_id / (file_id + extension)
                    destination = self.server.store.directory / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    mime = MEDIA_TYPES.get(extension, mimetypes.guess_type(name)[0] or 'application/octet-stream')
                    destination.write_bytes(body)
                    try:
                        db.execute('INSERT INTO files VALUES (?,?,?,?,?,?)',
                                   (file_id, piece_id, name, mime, len(body), str(relative)))
                        db.commit()
                    except Exception:
                        destination.unlink(missing_ok=True)
                        raise
                return self.json_response({'id': file_id, 'name': name, 'type': mime, 'size': len(body),
                                           'url': '/api/files/' + file_id}, 201)
            if self.command == 'DELETE' and not match[2]:
                with self.server.store.connect() as db:
                    files = db.execute('SELECT path FROM files WHERE piece_id=?', (piece_id,)).fetchall()
                    db.execute('DELETE FROM pieces WHERE id=?', (piece_id,))
                for file in files:
                    (self.server.store.directory / file['path']).unlink(missing_ok=True)
                return self.json_response({'ok': True})
        match = re.fullmatch(r'/api/files/([a-f0-9-]+)', path)
        if match and self.command == 'DELETE':
            with self.server.store.connect() as db:
                file = db.execute('SELECT path FROM files WHERE id=?', (match[1],)).fetchone()
                db.execute('DELETE FROM files WHERE id=?', (match[1],))
            if file:
                (self.server.store.directory / file['path']).unlink(missing_ok=True)
            return self.json_response({'ok': True})
        return self.error('Не найдено.', 404)


def make_server(host='127.0.0.1', port=8000, data_dir=None):
    server = ThreadingHTTPServer((host, port), Handler)
    server.store = Store(data_dir or ROOT / 'data')
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--data-dir', type=Path, default=ROOT / 'data')
    args = parser.parse_args()
    server = make_server(args.host, args.port, args.data_dir)
    print(f'Nota Studio: http://{args.host}:{server.server_port}; storage: {server.store.directory}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
