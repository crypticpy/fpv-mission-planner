#!/usr/bin/env python3
"""Static dev server with caching disabled.

`python3 -m http.server` sends Last-Modified and nothing else, so the browser
heuristically treats modules as fresh for hours — and the app's service worker
precaches whatever the HTTP cache hands it. Together they keep serving stale
modules long after an edit. `no-store` on every response keeps the dev loop
honest; production (GitHub Pages) sets its own headers.
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        # Detox endpoint: visiting /__fresh makes the browser drop this
        # origin's HTTP cache, service-worker registrations, and storage
        # before landing on a fresh copy of the app. The declarative header
        # is race-free where unregister-then-reload scripting is not.
        if self.path == '/__fresh':
            self.send_response(302)
            self.send_header('Location', '/')
            self.send_header('Clear-Site-Data', '"cache", "storage"')
            self.end_headers()
            return
        super().do_GET()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('port', nargs='?', type=int, default=8321)
    p.add_argument('--bind', default='127.0.0.1')
    p.add_argument('--directory', default='.')
    a = p.parse_args()
    server = ThreadingHTTPServer((a.bind, a.port), partial(NoCacheHandler, directory=a.directory))
    print(f'Serving {a.directory} on http://{a.bind}:{a.port} (Cache-Control: no-store)')
    server.serve_forever()


if __name__ == '__main__':
    main()
