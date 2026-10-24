"""run.bat 에서 백그라운드로 실행된다.
ComfyUI 가 응답하고 모바일 UI 서버까지 뜨면 기본 웹브라우저로 모바일 UI 페이지를 연다."""
import sys, time, urllib.error, urllib.request, webbrowser

COMFY_URL = "http://127.0.0.1:8188"
UI_URL = "http://127.0.0.1:7860"
TIMEOUT = 600  # 초. 이 시간 안에 준비되지 않으면 브라우저를 열지 않고 종료한다.

def is_up(url):
    try:
        with urllib.request.urlopen(url, timeout=2):
            return True
    except urllib.error.HTTPError:
        return True  # 응답 코드와 관계없이 서버가 응답했으면 실행 중으로 본다
    except Exception:
        return False

def wait_for(url, deadline):
    while time.time() < deadline:
        if is_up(url):
            return True
        time.sleep(2)
    return False

if __name__ == "__main__":
    if "--check" in sys.argv:  # ComfyUI 실행 여부만 확인 (종료 코드 0 = 실행 중)
        sys.exit(0 if is_up(f"{COMFY_URL}/system_stats") else 1)
    deadline = time.time() + TIMEOUT
    if not wait_for(f"{COMFY_URL}/system_stats", deadline):
        print(f"[open_browser] ComfyUI({COMFY_URL}) 응답이 없어 브라우저를 열지 않습니다.")
        sys.exit(1)
    if not wait_for(UI_URL, deadline):
        print(f"[open_browser] 모바일 UI 서버({UI_URL})가 뜨지 않아 브라우저를 열지 않습니다.")
        sys.exit(1)
    print(f"[open_browser] ComfyUI 실행 확인. 브라우저에서 {UI_URL} 를 엽니다.")
    webbrowser.open(UI_URL)
