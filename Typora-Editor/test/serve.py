"""Serve the extension regression page without caching development modules."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    workspace = Path(__file__).resolve().parent.parent
    server = ThreadingHTTPServer(("127.0.0.1", 8766), partial(Handler, directory=str(workspace)))
    print("Editor tests: http://127.0.0.1:8766/test/index.html", flush=True)
    server.serve_forever()
