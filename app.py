"""ComfyUI Mobile UI - Flask 백엔드 (실제 ComfyUI 연동)"""
import base64, hashlib, json, os, socket, threading, time, urllib.parse, urllib.request, uuid
from datetime import datetime, timezone
import yaml
import websocket
from flask import Flask, jsonify, render_template, request, send_from_directory

app = Flask(__name__)

# ===== 환경에 맞게 수정하세요 =====
COMFY_URL = "http://127.0.0.1:8188"
# ================================

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
STATE_FILE = os.path.join(DATA_DIR, "device_states.json")
IMAGE_DIR = os.path.join(DATA_DIR, "generated_images")
IMAGE_INDEX_FILE = os.path.join(IMAGE_DIR, "index.json")
TAGS_FILE = os.path.join(DATA_DIR, "tags.json")
COOKIE_MAX_AGE = 60 * 60 * 24 * 400
FIXED = {
    "anima": {"clip": "qwen_3_06b_base.safetensors", "vae": "Qwen_Image-VAE.safetensors"},
}

# ===== 모델 실제 폴더 경로 (CivitAI 정보 조회용 해시 계산에 필요) =====
# extra_model_paths.yaml 을 업로드하면 그 내용으로 대체되고(data/model_paths_config.json 에 저장),
# 업로드 전까지는 이 기본값을 그대로 쓴다.
DEFAULT_MODEL_BASE_PATHS = {
    "anima": "D:/AI_Gen/Anima",
    "il": "D:/AI_Gen/IL",
}
DEFAULT_MODEL_SUBFOLDER_CANDIDATES = {
    ("anima", "lora"): ["models/loras"],
    ("anima", "checkpoint"): ["models/unet", "models/diffusion_models"],
    ("il", "lora"): ["models/loras"],
    ("il", "checkpoint"): ["models/checkpoints"],
}
MODEL_PATHS_CONFIG_FILE = os.path.join(DATA_DIR, "model_paths_config.json")
MODEL_INFO_CACHE_FILE = os.path.join(DATA_DIR, "model_info_cache.json")


def _split_yaml_multiline(value):
    """extra_model_paths.yaml 의 'a: |\\n  path1\\n  path2' 형태(여러 줄) 또는
    단일 문자열 형태를 모두 하위 폴더 목록으로 정리한다."""
    if not value:
        return []
    return [line.strip() for line in str(value).splitlines() if line.strip()]


def parse_extra_model_paths_yaml(yaml_text):
    """ComfyUI가 그대로 쓰는 extra_model_paths.yaml 을 파싱해서
    ANIMA/IL 의 base_path 와 loras/checkpoint 하위 폴더 후보들을 뽑아낸다."""
    data = yaml.safe_load(yaml_text) or {}
    base_paths = {}
    subfolders = {}
    for yaml_key, family in (("ANIMA", "anima"), ("IL", "il")):
        entry = None
        for k, v in data.items():
            if isinstance(k, str) and k.upper() == yaml_key:
                entry = v or {}
                break
        if not entry:
            continue
        base_paths[family] = str(entry.get("base_path", "")).strip()

        subfolders[(family, "lora")] = _split_yaml_multiline(entry.get("loras"))
        checkpoint_candidates = []
        checkpoint_candidates += _split_yaml_multiline(entry.get("checkpoints"))
        checkpoint_candidates += _split_yaml_multiline(entry.get("diffusion_models"))
        subfolders[(family, "checkpoint")] = checkpoint_candidates
    return base_paths, subfolders


def load_model_paths_config():
    """업로드된 커스텀 경로 설정이 있으면 그걸, 없으면 기본값을 반환한다."""
    base_paths = dict(DEFAULT_MODEL_BASE_PATHS)
    subfolders = dict(DEFAULT_MODEL_SUBFOLDER_CANDIDATES)
    if os.path.isfile(MODEL_PATHS_CONFIG_FILE):
        try:
            with open(MODEL_PATHS_CONFIG_FILE, encoding="utf-8") as f:
                saved = json.load(f)
            base_paths.update(saved.get("base_paths", {}))
            for key, value in saved.get("subfolders", {}).items():
                family, kind = key.split(":", 1)
                if value:
                    subfolders[(family, kind)] = value
        except (json.JSONDecodeError, OSError, ValueError):
            pass
    return base_paths, subfolders


def save_model_paths_config(base_paths, subfolders):
    os.makedirs(DATA_DIR, exist_ok=True)
    payload = {
        "base_paths": base_paths,
        "subfolders": {f"{family}:{kind}": paths for (family, kind), paths in subfolders.items()},
    }
    with open(MODEL_PATHS_CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

# ---------- 상태 저장 (기존 기능) ----------

def load_states():
    if not os.path.exists(STATE_FILE):
        return {}
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}

def save_states(states):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(states, f, ensure_ascii=False, indent=2)

def get_device_id():
    device_id = request.cookies.get("device_id")
    return (device_id, False) if device_id else (uuid.uuid4().hex, True)

def with_cookie(resp, device_id, is_new):
    if is_new:
        resp.set_cookie("device_id", device_id, max_age=COOKIE_MAX_AGE, samesite="Lax")
    return resp

@app.route("/")
def base_page():
    return render_template("base.html")

@app.route("/api/state", methods=["GET"])
def get_state():
    device_id, is_new = get_device_id()
    resp = jsonify(load_states().get(device_id, {}))
    return with_cookie(resp, device_id, is_new)

@app.route("/api/state", methods=["POST"])
def save_state():
    device_id, is_new = get_device_id()
    payload = request.get_json(silent=True)
    states = load_states()
    states[device_id] = payload if isinstance(payload, dict) else {}
    save_states(states)
    return with_cookie(jsonify({"ok": True}), device_id, is_new)

# ---------- ComfyUI API 기반 모델 목록 ----------

def get_node_options(node_type, input_name):
    try:
        with urllib.request.urlopen(f"{COMFY_URL}/object_info/{urllib.parse.quote(node_type)}", timeout=10) as r:
            data = json.loads(r.read())

        info = data.get(node_type, {})
        if not info:
            print(f"[WARN] ComfyUI에 '{node_type}' 노드가 없습니다. (커스텀 노드/애드온 설치 여부 확인 필요)")
            return []

        required = info.get("input", {}).get("required", {})
        value = required.get(input_name)
        if value is None:
            print(f"[WARN] '{node_type}' 노드에 '{input_name}' 입력이 없습니다. 실제 입력 목록: {list(required.keys())}")
            return []

        if isinstance(value, list) and value:
            first = value[0]
            # 예전 방식: ["model_name"] -> [[옵션1, 옵션2, ...], {...}]
            if isinstance(first, list):
                return first
            # 최신 방식(schema V3): ["COMBO", {"options": [옵션1, 옵션2, ...], ...}]
            if isinstance(first, str) and first.upper() == "COMBO" and len(value) > 1 and isinstance(value[1], dict):
                return value[1].get("options", []) or []

        print(f"[WARN] '{node_type}.{input_name}' 응답 형식을 이해하지 못했습니다: {value!r}")
        return []
    except Exception as e:
        print(f"[ERROR] ComfyUI {node_type}.{input_name} 조회 실패: {e}")
        return []

FILTER_SETTINGS_FILE = os.path.join(DATA_DIR, "filter_settings.json")
DEFAULT_FILTER_KEYWORDS = {"anima": ["ANIMA"], "il": ["IL"]}
FILTER_KINDS = ("lora", "checkpoint")


def _default_family_filter():
    return {"keywords": [], "disabled": False}


def load_filter_settings():
    empty = {kind: {"anima": _default_family_filter(), "il": _default_family_filter()} for kind in FILTER_KINDS}
    if not os.path.isfile(FILTER_SETTINGS_FILE):
        return empty
    try:
        with open(FILTER_SETTINGS_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return empty

    # 이전 버전(로라 전용, lora_filter.json)과의 호환: 이 파일이 통째로
    # {"anima": [...], "il": [...]} 형태였다면 lora 필터로 간주해서 승계한다.
    if "anima" in data or "il" in data:
        data = {"lora": data, "checkpoint": {}}

    result = {}
    for kind in FILTER_KINDS:
        kind_data = data.get(kind, {})
        result[kind] = {}
        for family in ("anima", "il"):
            entry = kind_data.get(family)
            if isinstance(entry, dict):
                keywords = [k for k in entry.get("keywords", []) if isinstance(k, str) and k.strip()]
                disabled = bool(entry.get("disabled"))
            elif isinstance(entry, list):
                keywords = [k for k in entry if isinstance(k, str) and k.strip()]
                disabled = False
            else:
                keywords = []
                disabled = False
            result[kind][family] = {"keywords": keywords, "disabled": disabled}
    return result


def save_filter_settings(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(FILTER_SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def matches_keywords(name, keywords):
    if not isinstance(name, str):
        return False
    # 목록에는 하위 폴더가 포함된 경로 형태(예: "ANIMA/xxx.safetensors")로 오는 경우가
    # 있어서, 파일명이 아니라 이 경로 문자열 전체가 키워드로 시작하는지를 검사한다.
    upper = name.upper()
    return any(upper.startswith(kw.upper()) for kw in keywords if kw)


def apply_filter(kind, family, items):
    settings = load_filter_settings()
    entry = settings.get(kind, {}).get(family, _default_family_filter())
    if entry.get("disabled"):
        return list(items)
    keywords = entry.get("keywords") or DEFAULT_FILTER_KEYWORDS[family]
    return [x for x in items if matches_keywords(x, keywords)]


def get_comfyui_models():
    # Anima는 UNETLoader의 unet_name, IL은 CheckpointLoaderSimple의 ckpt_name을
    # 각각 따로 조회한다. 두 계열의 모델 구조를 절대로 섞지 않는다.
    anima_unets = get_node_options("UNETLoader", "unet_name")
    il_checkpoints = get_node_options("CheckpointLoaderSimple", "ckpt_name")
    all_loras = get_node_options("LoraLoader", "lora_name")
    clips = get_node_options("CLIPLoader", "clip_name")
    vaes = get_node_options("VAELoader", "vae_name")

    return {
        "anima": {
            "checkpoints": apply_filter("checkpoint", "anima", anima_unets),
            "loras": apply_filter("lora", "anima", all_loras),
            "clips": clips,
            "vaes": vaes,
        },
        "il": {
            "checkpoints": apply_filter("checkpoint", "il", il_checkpoints),
            "loras": apply_filter("lora", "il", all_loras),
            "vaes": vaes,
        },
    }

@app.route("/api/filter-settings/<kind>")
def api_get_filter_settings(kind):
    if kind not in FILTER_KINDS:
        return jsonify({"error": "unknown kind"}), 404
    current = load_filter_settings()
    return jsonify({
        "anima": current.get(kind, {}).get("anima", _default_family_filter()),
        "il": current.get(kind, {}).get("il", _default_family_filter()),
        "defaults": DEFAULT_FILTER_KEYWORDS,
    })

@app.route("/api/filter-settings/<kind>", methods=["POST"])
def api_save_filter_settings(kind):
    if kind not in FILTER_KINDS:
        return jsonify({"error": "unknown kind"}), 404
    payload = request.get_json(silent=True) or {}
    # "일괄 적용": kinds에 ["lora", "checkpoint"]를 지정하면 같은 키워드를 두 종류 모두에 적용한다.
    target_kinds = payload.get("kinds") or [kind]
    target_kinds = [k for k in target_kinds if k in FILTER_KINDS]

    settings = load_filter_settings()
    for target_kind in target_kinds:
        for family in ("anima", "il"):
            if family not in payload:
                continue
            raw = payload[family]
            if isinstance(raw, dict):
                keywords_raw = raw.get("keywords", "")
                disabled = bool(raw.get("disabled"))
            else:
                keywords_raw = raw
                disabled = False
            if isinstance(keywords_raw, str):
                keywords = [k.strip() for k in keywords_raw.split(",") if k.strip()]
            elif isinstance(keywords_raw, list):
                keywords = [k.strip() for k in keywords_raw if isinstance(k, str) and k.strip()]
            else:
                keywords = []
            settings[target_kind][family] = {"keywords": keywords, "disabled": disabled}
    save_filter_settings(settings)
    return jsonify(settings.get(kind, {}))

def find_model_file(family, kind, raw_name):
    """ComfyUI가 알려준 상대 경로(raw_name)로 실제 로컬 파일을 찾는다.
    여러 하위 폴더 후보(예: unet/diffusion_models)를 순서대로 시도한다."""
    base_paths, subfolders = load_model_paths_config()
    base = base_paths.get(family)
    if not base:
        return None
    normalized = raw_name.replace("\\", os.sep).replace("/", os.sep)
    for sub in subfolders.get((family, kind), []):
        candidate = os.path.join(base, sub, normalized)
        if os.path.isfile(candidate):
            return candidate
    return None


def compute_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def load_model_info_cache():
    if not os.path.isfile(MODEL_INFO_CACHE_FILE):
        return {}
    try:
        with open(MODEL_INFO_CACHE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_model_info_cache(cache):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(MODEL_INFO_CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


def fetch_civitai_info_by_hash(file_hash):
    url = f"https://civitai.com/api/v1/model-versions/by-hash/{file_hash}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read())

    images = []
    for img in (data.get("images") or [])[:8]:
        meta = img.get("meta") or {}
        images.append({
            "url": img.get("url", ""),
            "prompt": meta.get("prompt", ""),
        })

    return {
        "name": data.get("model", {}).get("name") or data.get("name", ""),
        "versionName": data.get("name", ""),
        "baseModel": data.get("baseModel", "Unknown"),
        "trainedWords": data.get("trainedWords", []),
        "description": data.get("description") or (data.get("model") or {}).get("description") or "",
        "images": images,
        "civitaiUrl": f"https://civitai.com/models/{data.get('modelId', '')}?modelVersionId={data.get('id', '')}",
    }


@app.route("/api/model-paths")
def api_get_model_paths():
    base_paths, subfolders = load_model_paths_config()
    is_custom = os.path.isfile(MODEL_PATHS_CONFIG_FILE)
    return jsonify({
        "isCustom": is_custom,
        "basePaths": base_paths,
        "subfolders": {f"{family}:{kind}": paths for (family, kind), paths in subfolders.items()},
    })

@app.route("/api/model-paths/upload", methods=["POST"])
def api_upload_model_paths():
    file = request.files.get("file")
    if file:
        yaml_text = file.read().decode("utf-8")
    else:
        payload = request.get_json(silent=True) or {}
        yaml_text = payload.get("yamlText", "")
    if not yaml_text or not yaml_text.strip():
        return jsonify({"error": "파일이나 텍스트가 없습니다."}), 400
    try:
        base_paths, subfolders = parse_extra_model_paths_yaml(yaml_text)
    except yaml.YAMLError as e:
        return jsonify({"error": f"YAML 파싱에 실패했습니다: {e}"}), 400

    if not base_paths:
        return jsonify({"error": "파일에서 ANIMA/IL 항목을 찾지 못했습니다."}), 400

    save_model_paths_config(base_paths, subfolders)
    # 경로가 바뀌었으니 예전 캐시(다른 폴더 기준으로 조회했을 수 있음)는 비워준다.
    if os.path.isfile(MODEL_INFO_CACHE_FILE):
        os.remove(MODEL_INFO_CACHE_FILE)

    return jsonify({
        "basePaths": base_paths,
        "subfolders": {f"{family}:{kind}": paths for (family, kind), paths in subfolders.items()},
    })

@app.route("/api/model-paths/set-base-paths", methods=["POST"])
def api_set_base_paths():
    """Anima/IL 의 base_path 를 계열별로 각각 따로 받는다. 한쪽만 입력해도 되고,
    입력 안 한 계열은 지금 설정(기본값 또는 예전에 저장해둔 커스텀 값)을 그대로 유지한다.
    하위 폴더 구조(loras/checkpoints 등)는 ComfyUI 표준 기본값을 그대로 쓴다."""
    payload = request.get_json(silent=True) or {}
    current_base_paths, current_subfolders = load_model_paths_config()
    updated = dict(current_base_paths)
    changed_families = []
    for family in ("anima", "il"):
        value = str(payload.get(family, "")).strip()
        if value:
            updated[family] = value
            changed_families.append(family)

    if not changed_families:
        return jsonify({"error": "최소 한 계열의 경로는 입력해주세요."}), 400

    save_model_paths_config(updated, current_subfolders)
    if os.path.isfile(MODEL_INFO_CACHE_FILE):
        os.remove(MODEL_INFO_CACHE_FILE)
    return jsonify({"basePaths": updated, "changed": changed_families})

@app.route("/api/model-paths/reset", methods=["POST"])
def api_reset_model_paths():
    if os.path.isfile(MODEL_PATHS_CONFIG_FILE):
        os.remove(MODEL_PATHS_CONFIG_FILE)
    if os.path.isfile(MODEL_INFO_CACHE_FILE):
        os.remove(MODEL_INFO_CACHE_FILE)
    return jsonify({"basePaths": DEFAULT_MODEL_BASE_PATHS})

WORKFLOWS_DIR = os.path.join(DATA_DIR, "workflows")
WORKFLOWS_INDEX_FILE = os.path.join(WORKFLOWS_DIR, "index.json")


def load_workflows_index():
    if not os.path.isfile(WORKFLOWS_INDEX_FILE):
        return []
    try:
        with open(WORKFLOWS_INDEX_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def save_workflows_index(index):
    os.makedirs(WORKFLOWS_DIR, exist_ok=True)
    with open(WORKFLOWS_INDEX_FILE, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)


@app.route("/api/workflows")
def api_list_workflows():
    family = request.args.get("family")
    index = load_workflows_index()
    if family:
        index = [w for w in index if w.get("family") == family]
    index.sort(key=lambda w: w.get("created_at", ""), reverse=True)
    return jsonify(index)


@app.route("/api/workflows", methods=["POST"])
def api_save_workflow():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    family = payload.get("family")
    app_state = payload.get("appState")
    if not name:
        return jsonify({"error": "이름을 입력해주세요."}), 400
    if family not in ("anima", "il"):
        return jsonify({"error": "알 수 없는 모델 계열입니다."}), 400
    if not isinstance(app_state, dict):
        return jsonify({"error": "설정 데이터가 올바르지 않습니다."}), 400

    wf_id = uuid.uuid4().hex
    comfy_workflow = None
    try:
        comfy_workflow, _ = build_prompt(app_state)
    except Exception:
        # ComfyUI가 꺼져있거나 체크포인트가 사라졌어도, 우리 앱 자체 재불러오기는
        # app_state만으로 가능하니 저장 자체는 막지 않는다.
        comfy_workflow = None

    record = {
        "id": wf_id,
        "name": name,
        "family": family,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "width": app_state.get("width"),
        "height": app_state.get("height"),
        "app_state": app_state,
        "comfy_workflow": comfy_workflow,
    }
    os.makedirs(WORKFLOWS_DIR, exist_ok=True)
    with open(os.path.join(WORKFLOWS_DIR, f"{wf_id}.json"), "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)

    index = load_workflows_index()
    index.append({
        "id": wf_id,
        "name": name,
        "family": family,
        "width": record["width"],
        "height": record["height"],
        "created_at": record["created_at"],
    })
    save_workflows_index(index)
    return jsonify({"id": wf_id, "name": name, "family": family})


@app.route("/api/workflows/<wf_id>")
def api_get_workflow(wf_id):
    path = os.path.join(WORKFLOWS_DIR, f"{wf_id}.json")
    if not os.path.isfile(path):
        return jsonify({"error": "찾을 수 없습니다."}), 404
    with open(path, encoding="utf-8") as f:
        return jsonify(json.load(f))


@app.route("/api/workflows/<wf_id>", methods=["DELETE"])
def api_delete_workflow(wf_id):
    path = os.path.join(WORKFLOWS_DIR, f"{wf_id}.json")
    if os.path.isfile(path):
        os.remove(path)
    index = [w for w in load_workflows_index() if w.get("id") != wf_id]
    save_workflows_index(index)
    return jsonify({"ok": True})


@app.route("/api/workflows", methods=["DELETE"])
def api_delete_all_workflows():
    for w in load_workflows_index():
        path = os.path.join(WORKFLOWS_DIR, f"{w.get('id')}.json")
        if os.path.isfile(path):
            os.remove(path)
    save_workflows_index([])
    return jsonify({"ok": True})


def extract_png_text_chunks(file_bytes):
    """PNG의 tEXt/iTXt 청크에서 ComfyUI가 심어둔 메타데이터(보통 'prompt' 키)를 읽는다."""
    if file_bytes[:8] != b"\x89PNG\r\n\x1a\n":
        return {}
    chunks = {}
    pos = 8
    n = len(file_bytes)
    while pos + 8 <= n:
        length = int.from_bytes(file_bytes[pos:pos + 4], "big")
        ctype = file_bytes[pos + 4:pos + 8].decode("ascii", "ignore")
        data = file_bytes[pos + 8:pos + 8 + length]
        if ctype == "tEXt" and b"\x00" in data:
            key, _, val = data.partition(b"\x00")
            chunks[key.decode("latin1", "ignore")] = val.decode("latin1", "ignore")
        elif ctype == "iTXt":
            parts = data.split(b"\x00", 4)
            if len(parts) == 5:
                try:
                    chunks[parts[0].decode("latin1", "ignore")] = parts[4].decode("utf-8", "ignore")
                except Exception:
                    pass
        pos += 8 + length + 4
        if ctype == "IEND":
            break
    return chunks


def validate_workflow_structure(prompt_dict):
    """이 앱이 알아볼 수 있는 최소한의 노드 구성을 갖췄는지 확인한다."""
    if not isinstance(prompt_dict, dict) or not prompt_dict:
        return False
    class_types = [n.get("class_type") for n in prompt_dict.values() if isinstance(n, dict)]
    has_prompt_nodes = class_types.count("CLIPTextEncode") >= 2
    has_loader = "UNETLoader" in class_types or "CheckpointLoaderSimple" in class_types
    has_sampler = "KSampler" in class_types
    return has_prompt_nodes and has_loader and has_sampler


def detect_family_from_workflow(prompt_dict):
    class_types = {n.get("class_type") for n in prompt_dict.values() if isinstance(n, dict)}
    if "UNETLoader" in class_types:
        return "anima"
    if "CheckpointLoaderSimple" in class_types:
        return "il"
    return None


def _resolve_conditioning_text(prompt_dict, ref, visited=None):
    """conditioning 참조를 따라간다. ConditioningCombine/ConditioningSetArea(SetMask)를
    거치더라도(영역별 프롬프트로 감싸져 있어도) 그 안의 CLIPTextEncode 텍스트를 찾아낸다.
    ConditioningCombine은 conditioning_1을 전역(베이스) 프롬프트로 우선 취급한다."""
    if visited is None:
        visited = set()
    if not (isinstance(ref, list) and len(ref) == 2):
        return ""
    node_id = str(ref[0])
    if node_id in visited:
        return ""
    visited.add(node_id)
    node = prompt_dict.get(node_id)
    if not isinstance(node, dict):
        return ""
    class_type = node.get("class_type")
    inputs = node.get("inputs", {})
    if class_type == "CLIPTextEncode":
        return inputs.get("text", "")
    if class_type in ("ConditioningSetArea", "ConditioningSetMask"):
        return _resolve_conditioning_text(prompt_dict, inputs.get("conditioning"), visited)
    if class_type == "ConditioningCombine":
        text1 = _resolve_conditioning_text(prompt_dict, inputs.get("conditioning_1"), visited)
        if text1:
            return text1
        return _resolve_conditioning_text(prompt_dict, inputs.get("conditioning_2"), visited)
    return ""


def _collect_area_node_ids(prompt_dict, ref, visited=None):
    """conditioning 참조 트리를 순회해서 ConditioningSetArea 노드 id들을 전부 모은다
    (영역별 프롬프트 복원용)."""
    if visited is None:
        visited = set()
    if not (isinstance(ref, list) and len(ref) == 2):
        return []
    node_id = str(ref[0])
    if node_id in visited:
        return []
    visited.add(node_id)
    node = prompt_dict.get(node_id)
    if not isinstance(node, dict):
        return []
    class_type = node.get("class_type")
    inputs = node.get("inputs", {})
    if class_type == "ConditioningSetArea":
        return [node_id]
    if class_type == "ConditioningCombine":
        return (
            _collect_area_node_ids(prompt_dict, inputs.get("conditioning_1"), visited)
            + _collect_area_node_ids(prompt_dict, inputs.get("conditioning_2"), visited)
        )
    return []


def extract_prompts_from_workflow(prompt_dict):
    ksamplers = [n for n in prompt_dict.values() if isinstance(n, dict) and n.get("class_type") == "KSampler"]
    if not ksamplers:
        return "", ""
    inputs = ksamplers[0].get("inputs", {})
    return (
        _resolve_conditioning_text(prompt_dict, inputs.get("positive")),
        _resolve_conditioning_text(prompt_dict, inputs.get("negative")),
    )


def extract_regions_from_workflow(prompt_dict):
    """KSampler의 positive/negative에 ConditioningSetArea(영역별 프롬프트)가 섞여 있으면
    그 영역들을 복원한다. 같은 좌표/크기의 area가 negative 쪽에도 있으면 그 영역은
    '커스텀 부정 프롬프트'를 쓰는 것으로 간주한다."""
    ksamplers = [n for n in prompt_dict.values() if isinstance(n, dict) and n.get("class_type") == "KSampler"]
    if not ksamplers:
        return []
    inputs = ksamplers[0].get("inputs", {})
    pos_area_ids = _collect_area_node_ids(prompt_dict, inputs.get("positive"))
    neg_area_ids = _collect_area_node_ids(prompt_dict, inputs.get("negative"))

    regions = []
    for area_id in pos_area_ids:
        area_inputs = prompt_dict.get(area_id, {}).get("inputs", {})
        region = {
            "x": area_inputs.get("x", 0),
            "y": area_inputs.get("y", 0),
            "w": area_inputs.get("width", 64),
            "h": area_inputs.get("height", 64),
            "strength": area_inputs.get("strength", 1.0),
            "positivePrompt": _resolve_conditioning_text(prompt_dict, area_inputs.get("conditioning")),
            "useMainNeg": True,
            "negativePrompt": "",
        }
        for neg_id in neg_area_ids:
            neg_inputs = prompt_dict.get(neg_id, {}).get("inputs", {})
            if (
                neg_inputs.get("x") == region["x"] and neg_inputs.get("y") == region["y"]
                and neg_inputs.get("width") == region["w"] and neg_inputs.get("height") == region["h"]
            ):
                neg_text = _resolve_conditioning_text(prompt_dict, neg_inputs.get("conditioning"))
                if neg_text:
                    region["useMainNeg"] = False
                    region["negativePrompt"] = neg_text
                break
        regions.append(region)
    return regions


def detect_hires(prompt_dict):
    """hires는 명시적인 표시가 없으므로, 2단계 샘플링(업스케일 뒤 KSampler가 또 있는지) 패턴으로 추정한다."""
    class_types = [n.get("class_type") for n in prompt_dict.values() if isinstance(n, dict)]
    sampler_count = class_types.count("KSampler") + class_types.count("KSamplerAdvanced")
    has_upscale = any(
        ct in ("LatentUpscale", "LatentUpscaleBy", "ImageUpscaleWithModel", "ImageScale", "ImageScaleBy")
        for ct in class_types
    )
    return sampler_count >= 2 and has_upscale


def extract_app_state_from_workflow(prompt_dict, family):
    positive, negative = extract_prompts_from_workflow(prompt_dict)
    regions = extract_regions_from_workflow(prompt_dict)

    checkpoint = ""
    for node in prompt_dict.values():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") == "UNETLoader":
            checkpoint = node.get("inputs", {}).get("unet_name", "")
        elif node.get("class_type") == "CheckpointLoaderSimple":
            checkpoint = node.get("inputs", {}).get("ckpt_name", "")

    width = height = None
    for node in prompt_dict.values():
        if isinstance(node, dict) and node.get("class_type") == "EmptyLatentImage":
            width = node.get("inputs", {}).get("width")
            height = node.get("inputs", {}).get("height")
            break

    loras = []
    for node in prompt_dict.values():
        if isinstance(node, dict) and node.get("class_type") == "LoraLoader":
            inp = node.get("inputs", {})
            loras.append({
                "file": inp.get("lora_name", ""),
                "strengthModel": inp.get("strength_model", 1),
                "strengthClip": inp.get("strength_clip", 1),
            })

    sampler = scheduler = steps = cfg = seed = None
    for node in prompt_dict.values():
        if isinstance(node, dict) and node.get("class_type") == "KSampler":
            inp = node.get("inputs", {})
            sampler = inp.get("sampler_name")
            scheduler = inp.get("scheduler")
            steps = inp.get("steps")
            cfg = inp.get("cfg")
            seed = inp.get("seed")
            break

    return {
        "family": family,
        "positivePrompt": positive,
        "negativePrompt": negative,
        "regions": regions,
        "checkpoint": checkpoint,
        "width": width,
        "height": height,
        "sampler": sampler,
        "scheduler": scheduler,
        "steps": steps,
        "cfg": cfg,
        "seed": str(seed) if seed is not None else None,
        "loras": loras,
        "hires": {"enabled": detect_hires(prompt_dict)},
    }


@app.route("/api/workflows/parse", methods=["POST"])
def api_parse_workflow_file():
    """파일 업로드 또는 ComfyUI로 생성된 이미지에서 워크플로우를 추출한다.
    우리 앱이 알아볼 수 있는 구조가 아니면 mismatch 오류를 돌려준다."""
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "파일이 없습니다."}), 400
    raw = file.read()

    prompt_dict = None
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        chunks = extract_png_text_chunks(raw)
        text = chunks.get("prompt")
        if text:
            try:
                prompt_dict = json.loads(text)
            except json.JSONDecodeError:
                prompt_dict = None
    else:
        try:
            prompt_dict = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            prompt_dict = None

    if not validate_workflow_structure(prompt_dict):
        return jsonify({"error": "mismatch"}), 422

    family = detect_family_from_workflow(prompt_dict)
    if not family:
        return jsonify({"error": "mismatch"}), 422

    app_state = extract_app_state_from_workflow(prompt_dict, family)
    return jsonify({"family": family, "appState": app_state})


@app.route("/api/model-info")
def api_model_info():
    family = request.args.get("family", "anima").lower()
    kind = request.args.get("kind", "lora").lower()
    raw_name = request.args.get("name", "")
    if not raw_name:
        return jsonify({"error": "name 파라미터가 필요합니다."}), 400

    cache_key = f"{family}:{kind}:{raw_name}"
    cache = load_model_info_cache()
    if cache_key in cache:
        return jsonify(cache[cache_key])

    path = find_model_file(family, kind, raw_name)
    if not path:
        result = {"error": "로컬에서 실제 파일을 찾지 못했습니다. 경로 설정을 확인해주세요."}
        return jsonify(result), 404

    try:
        file_hash = compute_sha256(path)
        info = fetch_civitai_info_by_hash(file_hash)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            result = {"error": "CivitAI에서 이 모델을 찾지 못했습니다 (등록되지 않은 모델일 수 있습니다)."}
            cache[cache_key] = result
            save_model_info_cache(cache)
            return jsonify(result), 404
        return jsonify({"error": f"CivitAI 조회 실패: {e}"}), 502
    except Exception as e:
        return jsonify({"error": f"조회 중 오류가 발생했습니다: {e}"}), 500

    cache[cache_key] = info
    save_model_info_cache(cache)
    return jsonify(info)


RESOLUTION_PRESETS_FILE = os.path.join(DATA_DIR, "resolution_presets.json")


def load_resolution_presets():
    if not os.path.isfile(RESOLUTION_PRESETS_FILE):
        return []
    try:
        with open(RESOLUTION_PRESETS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def save_resolution_presets(presets):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(RESOLUTION_PRESETS_FILE, "w", encoding="utf-8") as f:
        json.dump(presets, f, ensure_ascii=False, indent=2)


@app.route("/api/resolution-presets")
def api_get_resolution_presets():
    return jsonify(load_resolution_presets())


@app.route("/api/resolution-presets", methods=["POST"])
def api_add_resolution_preset():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    try:
        width = int(payload.get("width"))
        height = int(payload.get("height"))
    except (TypeError, ValueError):
        return jsonify({"error": "너비/높이가 올바르지 않습니다."}), 400
    if not name or width <= 0 or height <= 0:
        return jsonify({"error": "이름과 유효한 너비/높이가 필요합니다."}), 400

    presets = load_resolution_presets()
    preset = {"id": uuid.uuid4().hex, "name": name, "width": width, "height": height}
    presets.append(preset)
    save_resolution_presets(presets)
    return jsonify(preset)


@app.route("/api/resolution-presets/<preset_id>", methods=["DELETE"])
def api_delete_resolution_preset(preset_id):
    presets = load_resolution_presets()
    presets = [p for p in presets if p.get("id") != preset_id]
    save_resolution_presets(presets)
    return jsonify({"ok": True})


@app.route("/api/models")
def api_models():
    family = request.args.get("family", "anima").lower()
    if family not in ("anima", "il"):
        family = "anima"
    models = get_comfyui_models()
    resp = jsonify(models[family])
    resp.headers["Cache-Control"] = "no-store"
    return resp

@app.route("/api/samplers")
def api_samplers():
    return jsonify({
        "samplers": get_node_options("KSampler", "sampler_name"),
        "schedulers": get_node_options("KSampler", "scheduler"),
    })

@app.route("/api/upscale-models")
def api_upscale_models():
    return jsonify({"models": get_node_options("UpscaleModelLoader", "model_name")})

@app.route("/api/hires-options")
def api_hires_options():
    return jsonify({"methods": get_node_options("LatentUpscaleBy", "upscale_method")})

@app.route("/api/debug/object-info/<node_type>")
def api_debug_object_info(node_type):
    """ComfyUI가 특정 노드에 대해 실제로 어떤 응답을 주는지 그대로 확인하기 위한 디버그용 라우트.
    브라우저에서 http://127.0.0.1:7860/api/debug/object-info/UpscaleModelLoader 로 열어보면 됩니다."""
    try:
        with urllib.request.urlopen(f"{COMFY_URL}/object_info/{urllib.parse.quote(node_type)}", timeout=10) as r:
            return jsonify(json.loads(r.read()))
    except Exception as e:
        return jsonify({"error": str(e)}), 502

# ---------- 생성 이미지 보관 ----------

def load_image_index():
    if not os.path.exists(IMAGE_INDEX_FILE):
        return []
    try:
        with open(IMAGE_INDEX_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []

def save_image_index(items):
    os.makedirs(IMAGE_DIR, exist_ok=True)
    tmp = IMAGE_INDEX_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    os.replace(tmp, IMAGE_INDEX_FILE)

MAX_GENERATED_IMAGES = 20

def save_generated_image(img_bytes, image_info, data, pre_hires_bytes=None):
    os.makedirs(IMAGE_DIR, exist_ok=True)

    # 시드/프롬프트/설정이 이전과 완전히 같으면 ComfyUI가 캐시된 것과 똑같은 이미지를
    # 그대로 돌려주는 경우가 있다. 같은 계열의 가장 최근 이미지와 바이트 단위로 동일하면
    # 새로 추가하지 않고 기존 항목을 그대로 반환한다(목록에 중복으로 쌓이지 않도록).
    family = data.get("family", "anima")
    items = load_image_index()
    family_items = [it for it in items if it.get("family") == family]
    if family_items:
        most_recent = family_items[0]
        recent_path = os.path.join(IMAGE_DIR, most_recent.get("filename", ""))
        if os.path.isfile(recent_path):
            with open(recent_path, "rb") as f:
                if f.read() == img_bytes:
                    return most_recent

    filename = f"{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:10]}.png"
    with open(os.path.join(IMAGE_DIR, filename), "wb") as f:
        f.write(img_bytes)

    pre_hires_filename = ""
    if pre_hires_bytes:
        pre_hires_filename = f"{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:10]}_prehires.png"
        with open(os.path.join(IMAGE_DIR, pre_hires_filename), "wb") as f:
            f.write(pre_hires_bytes)

    item = {
        "id": uuid.uuid4().hex,
        "filename": filename,
        "url": f"/generated-images/{urllib.parse.quote(filename)}",
        "pre_hires_filename": pre_hires_filename,
        "pre_hires_url": f"/generated-images/{urllib.parse.quote(pre_hires_filename)}" if pre_hires_filename else "",
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "seed": str(data.get("seed", "")),
        "family": data.get("family", "anima"),
        "width": int(data.get("width", 960)),
        "height": int(data.get("height", 1280)),
        "source_filename": image_info.get("filename", ""),
        "hires": bool((data.get("hires") or {}).get("enabled")),
        "upscale": bool(data.get("upscale_model")),
        "settings": data,
    }
    items = load_image_index()
    items.insert(0, item)

    # 최신 MAX_GENERATED_IMAGES개만 계열별로 각각 남기고, 밀려난(오래된) 이미지는 파일까지 삭제
    family = item["family"]
    family_items = [it for it in items if it.get("family") == family]
    if len(family_items) > MAX_GENERATED_IMAGES:
        overflow = family_items[MAX_GENERATED_IMAGES:]
        overflow_ids = {it["id"] for it in overflow}
        for old in overflow:
            remove_item_files(old)
        items = [it for it in items if it.get("id") not in overflow_ids]

    save_image_index(items)
    return item

def remove_item_files(item):
    for fname_key in ("filename", "pre_hires_filename"):
        fname = item.get(fname_key)
        if not fname:
            continue
        path = os.path.join(IMAGE_DIR, fname)
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass


@app.route("/api/generated-images/<item_id>", methods=["DELETE"])
def delete_generated_image(item_id):
    items = load_image_index()
    remaining = []
    deleted = False
    for item in items:
        if item.get("id") == item_id:
            deleted = True
            remove_item_files(item)
        else:
            remaining.append(item)
    save_image_index(remaining)
    return jsonify({"ok": True, "deleted": deleted})

@app.route("/api/generated-images/clear", methods=["POST"])
def clear_generated_images():
    """특정 계열(family)의 생성 이미지를 전부 삭제한다. family 미지정 시 전체 삭제."""
    payload = request.get_json(silent=True) or {}
    family = payload.get("family")

    items = load_image_index()
    remaining = []
    deleted_count = 0
    for item in items:
        if family and item.get("family") != family:
            remaining.append(item)
            continue
        deleted_count += 1
        remove_item_files(item)
    save_image_index(remaining)
    return jsonify({"ok": True, "deleted": deleted_count})

@app.route("/api/generated-images")
def api_generated_images():
    family = request.args.get("family")
    items = []
    for item in load_image_index():
        if family and item.get("family") != family:
            continue
        filename = item.get("filename", "")
        if filename and os.path.isfile(os.path.join(IMAGE_DIR, filename)):
            item = dict(item)
            item["url"] = f"/generated-images/{urllib.parse.quote(filename)}"
            items.append(item)
    return jsonify(items)

@app.route("/generated-images/<path:filename>")
def generated_image(filename):
    return send_from_directory(IMAGE_DIR, filename)

# ---------- ComfyUI 워크플로우 생성 ----------

def build_prompt(data):
    family = data.get("family", "anima").lower()
    if family not in ("anima", "il"):
        raise ValueError("알 수 없는 모델 계열입니다.")

    ckpt = data.get("checkpoint")
    loras = data.get("loras", [])
    models = get_comfyui_models()[family]

    # UI에서 선택한 값도 생성 직전에 ComfyUI의 실제 목록과 다시 검증한다.
    if ckpt not in models["checkpoints"]:
        label = "UNET 모델" if family == "anima" else "체크포인트"
        raise ValueError(f"선택한 {label}을(를) ComfyUI에서 찾을 수 없습니다: {ckpt}")

    valid_loras = set(models["loras"])
    checked_loras = []
    for lora in loras:
        if not isinstance(lora, dict):
            continue
        name = lora.get("file")
        if name in valid_loras:
            checked_loras.append(lora)
    loras = checked_loras

    clip_choice = data.get("clip") or None
    vae_choice = data.get("vae") or None  # 빈 값/미선택이면 기본(내장) VAE 사용
    clip_skip_raw = data.get("clipSkip")
    clip_skip = None
    if clip_skip_raw not in (None, ""):
        try:
            clip_skip = int(clip_skip_raw)
        except (TypeError, ValueError):
            clip_skip = None

    prompt = {}

    if family == "anima":
        clip_name = clip_choice or FIXED["anima"]["clip"]
        vae_name = vae_choice or FIXED["anima"]["vae"]
        prompt["58"] = {"class_type": "UNETLoader", "inputs": {"unet_name": ckpt, "weight_dtype": "default"}}
        prompt["56"] = {"class_type": "CLIPLoader", "inputs": {"clip_name": clip_name, "type": "stable_diffusion", "device": "default"}}
        prompt["57"] = {"class_type": "VAELoader", "inputs": {"vae_name": vae_name}}
        model_ref, raw_clip_ref, vae_ref = ["58", 0], ["56", 0], ["57", 0]
    else:
        prompt["1"] = {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}}
        model_ref, raw_clip_ref = ["1", 0], ["1", 1]
        if vae_choice:
            prompt["60"] = {"class_type": "VAELoader", "inputs": {"vae_name": vae_choice}}
            vae_ref = ["60", 0]
        else:
            vae_ref = ["1", 2]  # 체크포인트 내장 VAE 사용

    if clip_skip is not None and family != "anima":
        prompt["30"] = {"class_type": "CLIPSetLastLayer", "inputs": {"clip": raw_clip_ref, "stop_at_clip_layer": clip_skip}}
        clip_ref = ["30", 0]
    else:
        clip_ref = raw_clip_ref

    nid = 100
    for lora in loras:
        n = str(nid); nid += 1
        prompt[n] = {
            "class_type": "LoraLoader",
            "inputs": {
                "model": model_ref, "clip": clip_ref,
                "lora_name": lora.get("file"),
                "strength_model": float(lora.get("strengthModel", 1)),
                "strength_clip": float(lora.get("strengthClip", 1)),
            },
        }
        model_ref, clip_ref = [n, 0], [n, 1]

    def normalize_prompt_text(text):
        # 알약형 태그 UI에서 시각적 구분용으로 쓰는 줄바꿈을, ComfyUI에 보낼 때만 ", "로 바꾼다.
        return (text or "").replace("\r\n", "\n").replace("\n", ", ")

    prompt["3"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": clip_ref, "text": normalize_prompt_text(data.get("positivePrompt", ""))}}
    prompt["4"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": clip_ref, "text": normalize_prompt_text(data.get("negativePrompt", ""))}}

    # 영역별 프롬프트: 각 영역의 텍스트를 CLIPTextEncode -> ConditioningSetArea 로 만들고,
    # 전체(기본) conditioning과 함께 ConditioningCombine 으로 합쳐서 KSampler에 넣는다.
    # 영역이 없으면 기존과 완전히 동일하게(["3",0]/["4",0] 그대로) 동작한다.
    positive_ref = ["3", 0]
    negative_ref = ["4", 0]
    regions = data.get("regions") or []
    if regions:
        next_node_id = [59]

        def alloc_id():
            next_node_id[0] += 1
            return str(next_node_id[0])

        def combine_chain(conds):
            current = conds[0]
            for c in conds[1:]:
                cid = alloc_id()
                prompt[cid] = {"class_type": "ConditioningCombine", "inputs": {"conditioning_1": current, "conditioning_2": c}}
                current = [cid, 0]
            return current

        positive_conds = [positive_ref]
        negative_conds = [negative_ref]
        for region in regions:
            rx, ry = int(region.get("x", 0)), int(region.get("y", 0))
            rw, rh = int(region.get("w", 64)), int(region.get("h", 64))
            r_strength = float(region.get("strength", 1.0))

            region_pos_text = normalize_prompt_text(region.get("positivePrompt", ""))
            if region_pos_text.strip():
                enc_id, area_id = alloc_id(), alloc_id()
                prompt[enc_id] = {"class_type": "CLIPTextEncode", "inputs": {"clip": clip_ref, "text": region_pos_text}}
                prompt[area_id] = {"class_type": "ConditioningSetArea", "inputs": {
                    "conditioning": [enc_id, 0], "width": rw, "height": rh, "x": rx, "y": ry, "strength": r_strength}}
                positive_conds.append([area_id, 0])

            if not region.get("useMainNeg", True):
                region_neg_text = normalize_prompt_text(region.get("negativePrompt", ""))
                if region_neg_text.strip():
                    enc_id, area_id = alloc_id(), alloc_id()
                    prompt[enc_id] = {"class_type": "CLIPTextEncode", "inputs": {"clip": clip_ref, "text": region_neg_text}}
                    prompt[area_id] = {"class_type": "ConditioningSetArea", "inputs": {
                        "conditioning": [enc_id, 0], "width": rw, "height": rh, "x": rx, "y": ry, "strength": r_strength}}
                    negative_conds.append([area_id, 0])

        positive_ref = combine_chain(positive_conds)
        negative_ref = combine_chain(negative_conds)

    prompt["51"] = {"class_type": "EmptyLatentImage", "inputs": {
        "width": int(data.get("width", 960)), "height": int(data.get("height", 1280)),
        "batch_size": 1}}
    prompt["52"] = {"class_type": "KSampler", "inputs": {
        "model": model_ref, "positive": positive_ref, "negative": negative_ref, "latent_image": ["51", 0],
        "seed": int(data.get("seed", 0)), "steps": int(data.get("steps", 24)),
        "cfg": float(data.get("cfg", 5)), "sampler_name": data.get("sampler", "euler_ancestral"),
        "scheduler": data.get("scheduler", "beta"), "denoise": 1}}
    prompt["53"] = {"class_type": "VAEDecode", "inputs": {"samples": ["52", 0], "vae": vae_ref}}
    prompt["17"] = {"class_type": "SaveImage", "inputs": {"images": ["53", 0], "filename_prefix": "mobile_ui"}}
    final_node = "17"

    hires = data.get("hires") or {}
    if hires.get("enabled"):
        upscale_method = hires.get("upscaleMethod") or "bilinear"
        scale_by = float(hires.get("scaleBy") or 1.25)
        h_steps = int(hires.get("steps") or 20)
        h_denoise = float(hires.get("denoise") if hires.get("denoise") not in (None, "") else 0.45)
        # CFG/샘플러/스케줄러는 고급에서 따로 지정하지 않았으면 기본(base) 값을 그대로 물려받는다.
        h_cfg = float(hires["cfg"]) if hires.get("cfg") not in (None, "") else float(data.get("cfg", 5))
        h_sampler = hires.get("sampler") or data.get("sampler", "euler_ancestral")
        h_scheduler = hires.get("scheduler") or data.get("scheduler", "beta")

        prompt["39"] = {"class_type": "LatentUpscaleBy", "inputs": {
            "samples": ["52", 0], "upscale_method": upscale_method, "scale_by": scale_by}}
        prompt["43"] = {"class_type": "KSampler", "inputs": {
            "model": model_ref, "positive": positive_ref, "negative": negative_ref, "latent_image": ["39", 0],
            "seed": int(data.get("seed", 0)), "steps": h_steps, "cfg": h_cfg,
            "sampler_name": h_sampler, "scheduler": h_scheduler, "denoise": h_denoise}}
        prompt["42"] = {"class_type": "VAEDecode", "inputs": {"samples": ["43", 0], "vae": vae_ref}}
        prompt["47"] = {"class_type": "SaveImage", "inputs": {"images": ["42", 0], "filename_prefix": "mobile_ui_hires"}}
        final_node = "47"

    return prompt, final_node


# 브라우저가 닫혀도 ComfyUI 생성은 계속 진행되도록 백그라운드 작업으로 실행합니다.
generation_jobs = {}
generation_jobs_lock = threading.Lock()

def fetch_view_bytes(image_info):
    q = urllib.parse.urlencode({
        "filename": image_info["filename"],
        "subfolder": image_info.get("subfolder", ""),
        "type": image_info.get("type", "output"),
    })
    with urllib.request.urlopen(f"{COMFY_URL}/view?{q}", timeout=30) as r:
        return r.read()


def run_prompt_and_fetch_image(job_id, prompt, final_node=None):
    """워크플로우(prompt)를 ComfyUI에 제출하고, 진행 상황을 job_id에 기록하며,
    완료되면 결과 이미지 바이트, image_info, 그리고 노드별 전체 출력(outputs)을 반환한다.
    (텍스트→이미지, 업스케일 공용) final_node 를 지정하면 그 노드의 출력을 우선 사용한다
    (예: hires 사용 시 base/hires SaveImage 노드가 둘 다 있으므로 어느 쪽이 최종 결과인지
    명시적으로 골라야 한다). outputs 를 함께 반환하는 이유는, hires 사용 시 base 단계
    이미지(다른 노드의 출력)도 나중에 같이 받아오기 위함이다."""
    total_nodes = len(prompt)
    client_id = uuid.uuid4().hex
    payload = json.dumps({"prompt": prompt, "client_id": client_id}).encode("utf-8")
    req = urllib.request.Request(f"{COMFY_URL}/prompt", data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        result = json.loads(r.read())

    prompt_id = result.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"ComfyUI가 프롬프트를 거부했습니다: {result.get('node_errors', result)}")

    with generation_jobs_lock:
        if job_id in generation_jobs:
            generation_jobs[job_id]["overall"] = 0
            generation_jobs[job_id]["step"] = 0
            generation_jobs[job_id]["prompt_id"] = prompt_id

    if not track_progress_via_websocket(job_id, prompt_id, client_id, total_nodes):
        wait_for_completion_by_polling(job_id, prompt_id)

    with urllib.request.urlopen(f"{COMFY_URL}/history/{prompt_id}", timeout=10) as r:
        history = json.loads(r.read())
    entry = history.get(prompt_id, {})
    outputs = entry.get("outputs", {})

    image_info = None
    if final_node and final_node in outputs and outputs[final_node].get("images"):
        image_info = outputs[final_node]["images"][0]
    if image_info is None:
        for node_out in outputs.values():
            if node_out.get("images"):
                image_info = node_out["images"][0]
                break
    if not image_info:
        raise TimeoutError("생성 시간이 초과되었거나 결과를 찾지 못했습니다.")

    img_bytes = fetch_view_bytes(image_info)
    return img_bytes, image_info, outputs


def generate_one_image(job_id, data):
    """이미지 1장을 생성: /prompt 제출 → 진행 추적 → /history, /view 로 결과 수신 → 저장.
    완료된 이미지 항목(dict)을 반환. 실패 시 예외를 던진다.
    hires 를 사용한 경우, hires 적용 전(base 단계) 이미지도 함께 받아와 같이 저장해서
    나중에 두 버전을 전환해서 볼 수 있게 한다."""
    prompt, final_node = build_prompt(data)
    img_bytes, image_info, outputs = run_prompt_and_fetch_image(job_id, prompt, final_node)

    pre_hires_bytes = None
    hires_enabled = bool((data.get("hires") or {}).get("enabled"))
    if hires_enabled and "17" in outputs and outputs["17"].get("images"):
        try:
            pre_hires_bytes = fetch_view_bytes(outputs["17"]["images"][0])
        except Exception as e:
            print(f"[WARN] hires 이전 이미지 조회 실패: {e}")

    return save_generated_image(img_bytes, image_info, data, pre_hires_bytes=pre_hires_bytes)


def interrupt_comfyui():
    """지금 ComfyUI에서 실행 중인 작업을 즉시 중단시킨다."""
    try:
        req = urllib.request.Request(f"{COMFY_URL}/interrupt", data=b"", method="POST")
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print(f"[WARN] ComfyUI 중단 요청 실패: {e}")


def upload_image_to_comfyui(img_bytes, filename):
    """이미지를 ComfyUI의 input 폴더로 업로드하고, ComfyUI가 저장한 파일명을 반환한다."""
    boundary = uuid.uuid4().hex
    parts = [
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
        f'Content-Type: image/png\r\n\r\n'.encode("utf-8"),
        img_bytes,
        f'\r\n--{boundary}\r\n'
        f'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'
        f'--{boundary}--\r\n'.encode("utf-8"),
    ]
    body = b"".join(parts)
    req = urllib.request.Request(
        f"{COMFY_URL}/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        result = json.loads(r.read())
    return result.get("name") or filename


def build_upscale_prompt(uploaded_filename, model_name):
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": uploaded_filename}},
        "2": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": model_name}},
        "3": {"class_type": "ImageUpscaleWithModel", "inputs": {"upscale_model": ["2", 0], "image": ["1", 0]}},
        "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0], "filename_prefix": "mobile_ui_upscale"}},
    }


def run_upscale_job(job_id, source_item, model_name):
    with generation_jobs_lock:
        generation_jobs[job_id] = {
            "status": "running", "total": 1, "completed": 0,
            "overall": 0, "step": 0, "images": [], "stop_requested": False,
        }
    try:
        src_path = os.path.join(IMAGE_DIR, source_item.get("filename", ""))
        with open(src_path, "rb") as f:
            src_bytes = f.read()

        uploaded_name = upload_image_to_comfyui(src_bytes, source_item.get("filename", "upscale_src.png"))
        prompt = build_upscale_prompt(uploaded_name, model_name)
        img_bytes, image_info, _outputs = run_prompt_and_fetch_image(job_id, prompt)

        # 업스케일 이전 이미지의 생성 설정을 그대로 물려받는다 (재사용 시 원본 설정이 나오도록).
        settings = dict(source_item.get("settings") or {})
        settings["upscale_model"] = model_name
        settings["upscaled_from"] = source_item.get("id")

        item = save_generated_image(img_bytes, image_info, settings)
        with generation_jobs_lock:
            generation_jobs[job_id]["images"] = [item]
            generation_jobs[job_id]["completed"] = 1
            generation_jobs[job_id]["status"] = "completed"
    except Exception as e:
        print(f"[ERROR] 업스케일 작업 {job_id}: {e}")
        with generation_jobs_lock:
            generation_jobs[job_id]["status"] = "error"
            generation_jobs[job_id]["error"] = str(e)


def run_batch_job(job_id, data):
    """배치 개수만큼 이미지를 하나씩 순차 생성한다.
    EmptyLatentImage 의 batch_size 는 항상 1로 고정하고(build_prompt 참고),
    여기서 요청을 batch 횟수만큼 반복하는 방식으로 처리한다.
    두 번째 이미지부터는 시드를 1씩 증가시켜, 배치 안에서 같은 시드가 반복되지 않게 한다."""
    total = max(1, int(data.get("batch", 1)))
    try:
        base_seed = int(data.get("seed", 0))
    except (TypeError, ValueError):
        base_seed = 0

    with generation_jobs_lock:
        generation_jobs[job_id] = {
            "status": "running",
            "total": total,
            "completed": 0,
            "overall": 0,
            "step": 0,
            "images": [],
            "stop_requested": False,
        }

    for i in range(total):
        with generation_jobs_lock:
            if generation_jobs[job_id]["stop_requested"]:
                generation_jobs[job_id]["status"] = "stopped"
                return

        item_data = dict(data)
        item_data["seed"] = base_seed + i

        try:
            item = generate_one_image(job_id, item_data)
        except Exception as e:
            with generation_jobs_lock:
                stopped = generation_jobs[job_id]["stop_requested"]
            if stopped:
                print(f"[INFO] 배치 작업 {job_id} 사용자가 중단함 ({i}/{total} 완료)")
                with generation_jobs_lock:
                    generation_jobs[job_id]["status"] = "stopped"
            else:
                print(f"[ERROR] 배치 작업 {job_id} ({i + 1}/{total}번째): {e}")
                with generation_jobs_lock:
                    generation_jobs[job_id]["status"] = "error"
                    generation_jobs[job_id]["error"] = str(e)
            return

        with generation_jobs_lock:
            generation_jobs[job_id]["images"].append(item)
            generation_jobs[job_id]["completed"] = i + 1
            if generation_jobs[job_id]["stop_requested"]:
                generation_jobs[job_id]["status"] = "stopped"
                return

    with generation_jobs_lock:
        generation_jobs[job_id]["status"] = "completed"


HIRES_NODE_IDS = {"39", "40", "41", "42", "43", "47"}
BASE_PREVIEW_NODE_ID = "17"


def track_progress_via_websocket(job_id, prompt_id, client_id, total_nodes):
    """ComfyUI /ws 로 실시간 진행 이벤트를 받아 단계별(step)/전체(overall) 진행도를 갱신.
    hires 사용 시, base 단계 이미지(17번 노드)가 완성되는 즉시 미리보기로 노출하고,
    hires 노드 실행이 시작되면 stage를 "hires"로 바꿔서 프론트가 블러 효과를 넣을 수 있게 한다.
    성공적으로 완료까지 지켜봤으면 True, 연결 실패 등으로 못 봤으면 False를 반환."""
    ws_url = COMFY_URL.replace("http://", "ws://").replace("https://", "wss://") + f"/ws?clientId={client_id}"
    try:
        ws = websocket.create_connection(ws_url, timeout=15)
    except Exception as e:
        print(f"[WARN] ComfyUI 웹소켓 연결 실패, 폴링 방식으로 대체: {e}")
        return False

    nodes_started = 0
    try:
        ws.settimeout(300)
        while True:
            raw = ws.recv()
            if not isinstance(raw, str):
                continue  # 바이너리 메시지(미리보기 이미지)는 무시
            event = json.loads(raw)
            etype = event.get("type")
            edata = event.get("data", {}) or {}

            if etype == "progress":
                value, max_value = edata.get("value", 0), edata.get("max", 0)
                step_pct = round(100 * value / max_value) if max_value else 0
                print(f"[WS] progress: {value}/{max_value} ({step_pct}%) node={edata.get('node')}")
                with generation_jobs_lock:
                    if job_id in generation_jobs:
                        generation_jobs[job_id]["step"] = step_pct

            elif etype == "executed":
                if edata.get("prompt_id") == prompt_id and edata.get("node") == BASE_PREVIEW_NODE_ID:
                    images = (edata.get("output") or {}).get("images")
                    if images:
                        with generation_jobs_lock:
                            if job_id in generation_jobs:
                                generation_jobs[job_id]["preview_image"] = images[0]

            elif etype == "executing":
                print(f"[WS] executing: node={edata.get('node')} prompt_id={edata.get('prompt_id')}")
                if edata.get("node") is None and edata.get("prompt_id") == prompt_id:
                    with generation_jobs_lock:
                        if job_id in generation_jobs:
                            generation_jobs[job_id]["overall"] = 100
                            generation_jobs[job_id]["step"] = 100
                    return True
                if edata.get("prompt_id") == prompt_id:
                    nodes_started += 1
                    overall_pct = min(round(100 * nodes_started / max(total_nodes, 1)), 99)
                    with generation_jobs_lock:
                        if job_id in generation_jobs:
                            generation_jobs[job_id]["overall"] = overall_pct
                            generation_jobs[job_id]["step"] = 0
                            if edata.get("node") in HIRES_NODE_IDS:
                                generation_jobs[job_id]["stage"] = "hires"
    except Exception as e:
        print(f"[WARN] 웹소켓 진행 추적 중단, 폴링 방식으로 대체: {e}")
        return False
    finally:
        try:
            ws.close()
        except Exception:
            pass


def wait_for_completion_by_polling(job_id, prompt_id):
    """웹소켓을 못 쓸 때의 대체 수단: /history 를 주기적으로 확인만 한다 (단계별 진행도는 알 수 없음)."""
    for _ in range(300):
        time.sleep(1)
        try:
            with urllib.request.urlopen(f"{COMFY_URL}/history/{prompt_id}", timeout=10) as r:
                history = json.loads(r.read())
        except Exception:
            continue
        entry = history.get(prompt_id)
        if entry and entry.get("outputs"):
            with generation_jobs_lock:
                if job_id in generation_jobs:
                    generation_jobs[job_id]["overall"] = 100
            return

@app.route("/api/generate", methods=["POST"])
def api_generate():
    data = request.get_json(silent=True) or {}
    job_id = uuid.uuid4().hex
    with generation_jobs_lock:
        generation_jobs[job_id] = {"status": "queued", "total": max(1, int(data.get("batch", 1))), "completed": 0, "images": []}
    threading.Thread(target=run_batch_job, args=(job_id, data), daemon=True).start()
    return jsonify({"job_id": job_id, "status": "queued"})

@app.route("/api/generate/<job_id>")
def api_generate_status(job_id):
    with generation_jobs_lock:
        job = generation_jobs.get(job_id)
    if not job:
        return jsonify({"status": "not_found"}), 404
    result = dict(job)
    if result.get("preview_image"):
        result["preview_url"] = f"/api/generate/{urllib.parse.quote(job_id)}/preview"
    return jsonify(result)

@app.route("/api/generate/<job_id>/preview")
def api_generate_preview(job_id):
    with generation_jobs_lock:
        job = generation_jobs.get(job_id)
    if not job or not job.get("preview_image"):
        return jsonify({"error": "미리보기가 아직 없습니다."}), 404
    try:
        img_bytes = fetch_view_bytes(job["preview_image"])
    except Exception as e:
        return jsonify({"error": f"미리보기를 가져오지 못했습니다: {e}"}), 502
    resp = app.response_class(img_bytes, mimetype="image/png")
    resp.headers["Cache-Control"] = "no-store"
    return resp

@app.route("/api/generate/<job_id>/stop", methods=["POST"])
def api_generate_stop(job_id):
    with generation_jobs_lock:
        job = generation_jobs.get(job_id)
        if job:
            job["stop_requested"] = True
    interrupt_comfyui()
    return jsonify({"ok": True})

@app.route("/api/upscale", methods=["POST"])
def api_upscale():
    payload = request.get_json(silent=True) or {}
    image_id = payload.get("image_id")
    model_name = payload.get("model_name")
    if not image_id or not model_name:
        return jsonify({"error": "이미지 또는 업스케일 모델이 지정되지 않았습니다."}), 400

    source_item = next((it for it in load_image_index() if it.get("id") == image_id), None)
    if not source_item:
        return jsonify({"error": "원본 이미지를 찾을 수 없습니다."}), 404

    job_id = uuid.uuid4().hex
    with generation_jobs_lock:
        generation_jobs[job_id] = {"status": "queued", "total": 1, "completed": 0, "images": []}
    threading.Thread(target=run_upscale_job, args=(job_id, source_item, model_name), daemon=True).start()
    return jsonify({"job_id": job_id, "status": "queued"})

TAG_DATA = []

def load_tag_dataset():
    global TAG_DATA
    if not os.path.isfile(TAGS_FILE):
        TAG_DATA = []
        print(f"[WARN] {TAGS_FILE} 이 없어 태그 자동완성이 비활성화됩니다.")
        return
    with open(TAGS_FILE, encoding="utf-8") as f:
        TAG_DATA = json.load(f)
    print(f"[INFO] 태그 데이터셋 로드 완료: {len(TAG_DATA)}개")

def format_count(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return ""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1000:.0f}K"
    return str(n)

def search_tags(query, limit=30):
    # 원본 데이터셋에는 "d.va (overwatch)"처럼 백슬래시 없이 저장되어 있는데,
    # 화면에는 "d.va \(overwatch\)" 형태로 보여주다 보니 사용자가 검색어에 백슬래시를
    # 그대로 입력하는 경우가 있다. 검색 시에는 백슬래시를 무시하고 매칭한다.
    q = query.strip().lower().replace("_", " ").replace("\\", "")
    if not q:
        return []
    scored = []
    for tag in TAG_DATA:
        en = (tag.get("english_name") or "").lower()
        kr = tag.get("korean_name") or ""
        kw = (tag.get("keyword") or "").lower()
        if en.startswith(q):
            score = 0
        elif q in en:
            score = 1
        elif q in kr.lower() or q in kw:
            score = 2
        else:
            continue
        scored.append((score, -int(tag.get("count") or 0), tag))
    scored.sort(key=lambda x: (x[0], x[1]))
    return [t for _, _, t in scored[:limit]]

@app.route("/api/tags/autocomplete")
def api_tags_autocomplete():
    q = request.args.get("q", "")
    limit = min(int(request.args.get("limit", 30) or 30), 50)
    results = search_tags(q, limit)
    return jsonify([
        {
            "en": t.get("english_name", ""),
            "kr": t.get("korean_name", ""),
            "desc": t.get("description", ""),
            "count": format_count(t.get("count", 0)),
        }
        for t in results
    ])

load_tag_dataset()

@app.route("/api/reset", methods=["POST"])
def api_reset():
    """저장된 설정(모든 계열)과 생성된 이미지를 전부 삭제하고 기본값으로 되돌린다."""
    device_id, is_new = get_device_id()
    states = load_states()
    states.pop(device_id, None)
    save_states(states)

    for item in load_image_index():
        path = os.path.join(IMAGE_DIR, item.get("filename", ""))
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass
    save_image_index([])

    return with_cookie(jsonify({"ok": True}), device_id, is_new)

# ---------- 서버 실행 ----------

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()

if __name__ == "__main__":
    PORT = 7860
    ip = get_local_ip()
    print("=" * 56)
    print(f" PC:     http://127.0.0.1:{PORT}")
    print(f" Mobile: http://{ip}:{PORT}")
    print(f" ComfyUI 대상: {COMFY_URL}")
    print("=" * 56)
    app.run(host="0.0.0.0", port=PORT, debug=True, threaded=True)
