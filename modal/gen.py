import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ["PYTHONUTF8"] = "1"
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE_DIR = Path(__file__).resolve().parent
MODAL_APP_PY = BASE_DIR / "modal_app.py"

HOST = "127.0.0.1"
GEN_PORT = 8765
VIEWER_PORT = 5000

APP_NAME = "krea2"
CLS_NAME = "Krea"

DEFAULT_WIDTH = 880
DEFAULT_HEIGHT = 1240
DEFAULT_NUMS = 1
UPLOAD_TO_MEGA = True

MIN_SIZE, MAX_SIZE = 64, 4096
MAX_NUMS = 25

VIEWER_PY = BASE_DIR / "flask/viewer.py"

krea = None
generate_lock = threading.Lock()
pending_lock = threading.Lock()
pending_request = {"data": None}

stop_event = threading.Event()

CONTAINER_STOP_TIMEOUT = 300
CONTAINER_POLL_INTERVAL = 3

def viewer_running() -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex((HOST, VIEWER_PORT)) == 0

def launch_viewer():
    if viewer_running():
        print(f"[viewer] 既に起動しています: http://{HOST}:{VIEWER_PORT}/")
        return
    kwargs = {}
    if os.name == "nt":

        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(
        [sys.executable, str(VIEWER_PY)], cwd=str(BASE_DIR),
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        close_fds=True, **kwargs,
    )
    print(f"[viewer] 別プロセスで起動しました: http://{HOST}:{VIEWER_PORT}/")

def run_modal(*args):
    cmd = [sys.executable, "-m", "modal", *args]
    result = subprocess.run(cmd, cwd=str(BASE_DIR))
    return result.returncode == 0

def deploy():
    print("Modalにデプロイしています...")
    if not run_modal("deploy", str(MODAL_APP_PY)):
        print("デプロイに失敗しました。")
        sys.exit(1)
    print("デプロイ完了。")

def find_container_ids():
    cmd = [sys.executable, "-m", "modal", "container", "list", "--json"]
    result = subprocess.run(cmd, cwd=str(BASE_DIR), capture_output=True,
                            text=True, encoding="utf-8")
    if result.returncode != 0:
        print(result.stderr.strip())
        return None
    try:
        rows = json.loads(result.stdout)
    except json.JSONDecodeError:
        print("コンテナ一覧(JSON)を読み取れませんでした。")
        return None

    ids = []
    for row in rows:
        norm = {k.lower().replace("_", " ").replace("-", " "): v for k, v in row.items()}
        app_name = str(norm.get("app name", ""))
        container_id = norm.get("container id")
        if container_id and APP_NAME in app_name:
            ids.append(container_id)
    return ids

def stop_containers():
    print("起動中のコンテナを確認しています...")
    ids = find_container_ids()
    if ids is None:
        print("確認に失敗しました。手動で確認してください: python -m modal container list")
        return
    if not ids:
        print("停止するコンテナはありません。")
        return

    for cid in ids:
        if run_modal("container", "stop", "-y", cid) or run_modal("container", "stop", cid):
            print(f"コンテナの停止を要求しました: {cid}")
        else:
            print(f"停止に失敗しました。手動で実行してください: python -m modal container stop {cid}")

    wait_containers_gone()

def wait_containers_gone():
    deadline = time.time() + CONTAINER_STOP_TIMEOUT
    while time.time() < deadline:
        ids = find_container_ids()
        if ids is not None and not ids:
            print("コンテナが完全に終了しました。")
            return
        time.sleep(CONTAINER_POLL_INTERVAL)
    print("タイムアウトしました。コンテナが残っている可能性があります: "
          "python -m modal container list")

def generate(krea, prompt, width, height, nums):
    print("生成中...")
    t0 = time.time()
    try:
        krea.generate.remote(
            prompt, w=width, h=height, n=nums, mega=UPLOAD_TO_MEGA,
        )
        print(f"\033[42m  完了({time.time() - t0:.0f}秒)  \033[0m")
        return True
    except Exception as e:
        print(f"生成に失敗しました: {type(e).__name__}: {e}")
        return False

class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message

def _get_int(data: dict, key: str, default: int, lo: int, hi: int) -> int:
    value = data.get(key, default)

    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ApiError(400, f"{key} は整数で指定してください")
    try:
        value = int(value)
    except ValueError:
        raise ApiError(400, f"{key} は整数で指定してください")
    if not lo <= value <= hi:
        raise ApiError(400, f"{key} は {lo}〜{hi} の範囲で指定してください")
    return value

def _set_pending(prompt, width, height, nums):
    with pending_lock:
        pending_request["data"] = (prompt, width, height, nums)

def _pop_pending():
    with pending_lock:
        data = pending_request["data"]
        pending_request["data"] = None
    return data

def _run_generate(prompt, width, height, nums):
    try:
        current = (prompt, width, height, nums)
        while current is not None and not stop_event.is_set():
            c_prompt, c_width, c_height, c_nums = current
            ok = generate(krea, c_prompt, c_width, c_height, c_nums)

            if stop_event.is_set():
                print("停止要求を受けているため、次の生成は開始しません。")
                break

            pending = _pop_pending()
            if pending is not None:
                current = pending
            elif ok:
                pass
            else:
                current = None
                print("生成に失敗したため、連続生成を止めます。次のリクエストを待ちます。")
    finally:
        generate_lock.release()

def handle_generate(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ApiError(400, "JSON オブジェクトを送ってください")

    prompt = data.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ApiError(400, "prompt は空でない文字列で指定してください")
    prompt = prompt.strip()

    width = _get_int(data, "width", DEFAULT_WIDTH, MIN_SIZE, MAX_SIZE)
    height = _get_int(data, "height", DEFAULT_HEIGHT, MIN_SIZE, MAX_SIZE)
    nums = _get_int(data, "nums", DEFAULT_NUMS, 1, MAX_NUMS)

    if stop_event.is_set():
        raise ApiError(503, "停止処理中のため、リクエストを受け付けられません")

    if not generate_lock.acquire(blocking=False):
        _set_pending(prompt, width, height, nums)
        return {
            "result": f"現在生成中のため、{width}x{height} を {nums}枚 のリクエストを保存しました。"
                       f"今の生成が終わり次第、この内容に切り替わります",
            "queued": True,
        }

    threading.Thread(
        target=_run_generate, args=(prompt, width, height, nums), daemon=True
    ).start()
    return {"result": f"{width}x{height} を {nums}枚 生成を開始しました", "queued": False}

ROUTES = {
    "/api/generate": handle_generate,
}

class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/ping":
            self._send_json(200, {"result": "pong"})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        func = ROUTES.get(self.path)
        if func is None:
            self._send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                raise ApiError(400, "JSON として読み取れませんでした")
            self._send_json(200, func(data))
        except ApiError as e:
            self._send_json(e.status, {"error": e.message})
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def log_message(self, format, *args):

        pass

def main():
    global krea

    parser = argparse.ArgumentParser(description="Krea 画像生成サーバー + 画像ビューア")
    parser.add_argument("-d", "--deploy", action="store_true",
                        help="起動時に modal deploy を実行する")
    args = parser.parse_args()

    if args.deploy:
        deploy()

    import modal
    krea = modal.Cls.from_name(APP_NAME, CLS_NAME)()

    launch_viewer()

    server = ThreadingHTTPServer((HOST, GEN_PORT), Handler)
    print(f"[gen] Listening on http://{HOST}:{GEN_PORT}  (Ctrl+C で停止)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nCtrl+C を受け付けました。実行中の生成が終わるのを待って停止します。\n\033[31mパソコンの電源を落としたり、ウィンドウを閉じないでください。\033[0m")
    finally:

        stop_event.set()
        server.server_close()
        _wait_for_generation()

        if _pop_pending() is not None:
            print("保存されていたリクエストは実行せずに破棄しました。")

        stop_containers()
    print("終了します")

def _on_sigint_while_stopping(signum, frame):
    print("\n停止処理中です。")

def _wait_for_generation():
    if generate_lock.acquire(blocking=False):
        generate_lock.release()
        return
    while not generate_lock.acquire(timeout=1):
        pass
    generate_lock.release()

if __name__ == "__main__":
    main()
