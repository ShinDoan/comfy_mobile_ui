// ============================================================
// ComfyUI API에서 받아온 실제 체크포인트 / LoRA 목록을
// 모델 계열별로 캐싱합니다.
// Anima: UNETLoader / Illustrious: CheckpointLoaderSimple
// ============================================================
let modelsCache = { anima: { checkpoints: [], loras: [] }, il: { checkpoints: [], loras: [] } };
// anima/il 각각 독립적으로 프롬프트, 체크포인트, LoRA, 설정을 저장합니다.
// 구조: { lastFamily: "anima", anima: {...}, il: {...} }
let savedStates = {};

async function loadModels() {
  const [a, i] = await Promise.all([
    fetch("/api/models?family=anima", { cache: "no-store" }).then((r) => r.json()),
    fetch("/api/models?family=il", { cache: "no-store" }).then((r) => r.json()),
  ]);
  modelsCache.anima = a;
  modelsCache.il = i;
}

let samplerCache = { samplers: [], schedulers: [] };
let upscaleModels = [];

async function loadUpscaleModels() {
  try {
    const data = await fetch("/api/upscale-models").then((r) => r.json());
    upscaleModels = data.models && data.models.length ? data.models : [];
  } catch (e) {
    upscaleModels = [];
  }

  const hidden = document.getElementById("upscaleModelSelect");
  setSearchableOptions(hidden, upscaleModels);

  const preferred = upscaleModels.includes("RealESRGAN_x4plus.pth")
    ? "RealESRGAN_x4plus.pth"
    : upscaleModels[0] || "";
  setSearchableValue(hidden, preferred);
}

async function loadSamplers() {
  const fallback = { samplers: ["euler_ancestral", "euler", "dpmpp_2m"], schedulers: ["beta", "karras", "normal"] };
  try {
    const data = await fetch("/api/samplers").then((r) => r.json());
    samplerCache = {
      samplers: data.samplers && data.samplers.length ? data.samplers : fallback.samplers,
      schedulers: data.schedulers && data.schedulers.length ? data.schedulers : fallback.schedulers,
    };
  } catch (e) {
    samplerCache = fallback;
  }
  setSearchableOptions(document.getElementById("samplerSelect"), samplerCache.samplers);
  setSearchableOptions(document.getElementById("schedulerSelect"), samplerCache.schedulers);
  setSearchableOptions(document.getElementById("hiresSamplerSelect"), samplerCache.samplers);
  setSearchableOptions(document.getElementById("hiresSchedulerSelect"), samplerCache.schedulers);
}

let hiresMethods = [];

async function loadHiresOptions() {
  const fallback = ["nearest-exact", "bilinear", "area", "bicubic", "bislerp"];
  try {
    const data = await fetch("/api/hires-options").then((r) => r.json());
    hiresMethods = data.methods && data.methods.length ? data.methods : fallback;
  } catch (e) {
    hiresMethods = fallback;
  }
  setSearchableOptions(document.getElementById("hiresUpscaleMethodSelect"), hiresMethods);
}

// ============================================================
// 공통 "검색 가능한 선택창" 컴포넌트
// 실제 <select> 대신 (검색용 텍스트 입력) + (실제 값을 담는 hidden input)
// + (검색 결과 드롭다운) 3개로 구성. hidden input 이 기존 select 역할을
// 그대로 대신하므로, .value 를 읽고 쓰는 나머지 코드는 그대로 동작한다.
// ============================================================

function normalizeOptions(list) {
  return (list || []).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
}

// 필터 키워드가 딱 1개일 때만("여러 개"면 어느 것이 매칭됐는지 모호해지므로 건드리지 않음),
// 화면에 보여줄 라벨에서 "키워드\" 접두사를 지운다. 실제로 서버에 보낼 값(value)은
// 원본 경로 그대로 유지한다.
function stripFilterPrefix(name, kind, family) {
  const entry = (filterState[kind] && filterState[kind][family]) || { keywords: [], disabled: false };
  if (entry.disabled) return name;
  const effective = entry.keywords && entry.keywords.length ? entry.keywords : (filterState.defaults[family] || []);
  if (effective.length !== 1) return name;
  const prefix = `${effective[0]}\\`;
  return name.toUpperCase().startsWith(prefix.toUpperCase()) ? name.slice(prefix.length) : name;
}

function optionsWithStrippedLabels(list, kind, family) {
  return (list || []).map((name) => ({ value: name, label: stripFilterPrefix(name, kind, family) }));
}

function setSearchableOptions(hidden, list) {
  hidden._options = normalizeOptions(list);
  syncSearchableDisplay(hidden);
}

function syncSearchableDisplay(hidden) {
  const display = hidden.previousElementSibling;
  if (!display) return;
  const opt = (hidden._options || []).find((o) => o.value === hidden.value);
  display.value = opt ? opt.label : hidden.value || "";
}

function setSearchableValue(hidden, value) {
  hidden.value = value;
  syncSearchableDisplay(hidden);
}

function pickValidOr(hidden, desired, fallbackFn) {
  const opts = hidden._options || [];
  if (desired && opts.some((o) => o.value === desired)) return desired;
  return fallbackFn ? fallbackFn(opts) : opts[0] ? opts[0].value : "";
}

function initSearchableSelect(hidden) {
  const display = hidden.previousElementSibling;
  const dropdown = hidden.nextElementSibling;
  if (!display || !dropdown) return;

  function render(list) {
    dropdown.innerHTML = list.length
      ? list
          .slice(0, 50)
          .map((o, idx) => `<div class="searchable-item" data-idx="${idx}">${o.label}</div>`)
          .join("")
      : '<div class="searchable-empty">검색 결과 없음</div>';
    dropdown._filtered = list;
    dropdown.style.display = "block";
  }

  function filter() {
    const terms = display.value.toLowerCase().split(/\s+/).filter(Boolean);
    const all = hidden._options || [];
    const list = terms.length
      ? all.filter((o) => {
          const label = o.label.toLowerCase();
          return terms.every((term) => label.includes(term));
        })
      : all;
    render(list);
  }

  display.addEventListener("focus", () => {
    display.value = "";
    filter();
  });
  display.addEventListener("input", filter);
  display.addEventListener("blur", () => {
    setTimeout(() => {
      dropdown.style.display = "none";
      syncSearchableDisplay(hidden);
    }, 150);
  });

  dropdown.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".searchable-item");
    if (!item) return;
    const opt = (dropdown._filtered || [])[parseInt(item.dataset.idx, 10)];
    if (!opt) return;
    hidden.value = opt.value;
    display.value = opt.label;
    dropdown.style.display = "none";
    hidden.dispatchEvent(new Event("input", { bubbles: true }));
    hidden.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

// ============================================================
// 태그 자동완성 검색 — 서버의 /api/tags/autocomplete (danbooru 데이터셋
// 37,175개 기반)를 호출해서 결과를 보여준다.
// ============================================================

let selectedTag = null;
let tagSearchDebounce = null;

function fmtTagName(en) {
  return en.replace(/([()])/g, "\\$1");
}

// 태그 자동완성 검색(가져오기+목록 렌더링)의 공용 로직.
// 텍스트 모드 인라인 자동완성과 태그 모드 편집창 자동완성이 이 함수를 그대로 같이 쓴다.
async function fetchTagSuggestions(query, limit) {
  const res = await fetch(`/api/tags/autocomplete?q=${encodeURIComponent(query)}&limit=${limit || 8}`);
  return res.json();
}

function renderTagSuggestionList(dropdown, items, onSelect) {
  if (!items.length) {
    dropdown.innerHTML = "";
    dropdown.style.display = "none";
    return;
  }
  dropdown.innerHTML = items
    .map(
      (t, i) => `
      <div class="inline-ac-item" data-idx="${i}">
        <span class="inline-ac-en">${fmtTagName(t.en)}</span>
        <span class="inline-ac-kr">${t.kr || ""}</span>
      </div>`
    )
    .join("");
  dropdown.style.display = "block";
  dropdown.querySelectorAll(".inline-ac-item").forEach((el) => {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      onSelect(items[parseInt(el.dataset.idx, 10)]);
    });
  });
}

// ============================================================
// 프롬프트 인라인 자동완성 — textarea 안, 실제 커서(입력 중인 글자)
// 바로 아래에 후보를 띄운다. textarea는 커서의 픽셀 좌표를 직접
// 알려주는 API가 없어서, 숨겨진 "미러 div"에 같은 스타일로 텍스트를
// 복사해 커서 위치를 계산하는 방식을 쓴다.
// ============================================================

function getCaretCoords(textarea, position) {
  const mirror = document.createElement("div");
  const style = getComputedStyle(textarea);
  [
    "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderLeftWidth", "boxSizing",
  ].forEach((p) => { mirror.style[p] = style[p]; });
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.width = textarea.clientWidth + "px";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";

  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement("span");
  marker.textContent = "|";
  mirror.appendChild(marker);
  mirror.appendChild(document.createTextNode(textarea.value.slice(position) || "."));

  document.body.appendChild(mirror);
  const coords = { top: marker.offsetTop, left: marker.offsetLeft, height: marker.offsetHeight };
  document.body.removeChild(mirror);
  return coords;
}

function getPromptSegment(textarea) {
  const pos = textarea.selectionStart;
  const value = textarea.value;
  const upto = value.slice(0, pos);
  // 쉼표뿐 아니라 줄바꿈도 세그먼트 경계로 본다. 안 그러면 줄바꿈 직후 첫 단어를 입력할 때
  // 윗줄의 마지막 단어까지 하나의 검색어로 잡혀버린다.
  const lastComma = upto.lastIndexOf(",");
  const lastBreak = upto.lastIndexOf("\n");
  const start = Math.max(lastComma, lastBreak) + 1;
  const raw = value.slice(start, pos);
  return { start, end: pos, text: raw.replace(/^\s+/, "") };
}

// ============================================================
// 알약형 태그 편집기 — 텍스트 모드와 알약 모드를 서로 전환 가능.
// 줄바꿈은 "시각적 구분"으로만 쓰이고(양쪽 모드에서 유지됨),
// ComfyUI로 보낼 때만 줄바꿈을 ", "로 바꾼다(실제 정규화는 서버에서 함,
// 여기 미리보기는 그 결과를 미리 보여주는 용도).
// 가중치 색상: 긍정 - 강할수록 하늘색→보라, 약할수록 연두→라임
//             부정 - 강할수록 주황→빨강, 약할수록 주황→노랑, 1.0은 무채색
// ============================================================

function makePillTag(text, weight) {
  return { type: "tag", text, weight };
}
function makePillBreak() {
  return { type: "break" };
}

function pillWeightColor(weight, isNegative) {
  if (Math.abs(weight - 1) < 0.001) return null;
  if (!isNegative) {
    if (weight > 1) {
      const t = Math.min(1, (weight - 1) / 1);
      return `hsl(${200 + t * 70}, 90%, 60%)`;
    }
    const t = Math.min(1, (1 - weight) / 0.9);
    const hue = 125 - t * 45;
    const sat = 55 + t * 45;
    const light = 42 + t * 15;
    return `hsl(${hue}, ${sat}%, ${light}%)`;
  }
  if (weight > 1) {
    const t = Math.min(1, (weight - 1) / 1);
    return `hsl(${30 - t * 30}, 90%, 55%)`;
  }
  const t = Math.min(1, (1 - weight) / 0.9);
  return `hsl(${30 + t * 25}, 90%, 55%)`;
}

// 소수 둘째 자리가 0이면(예: 1.20, 1.30) 굳이 다 쓰지 않고 1.2, 1.3처럼 짧게 표시한다.
function formatWeight(w) {
  const cents = Math.round(w * 100);
  return cents % 10 === 0 ? (cents / 100).toFixed(1) : (cents / 100).toFixed(2);
}

function pillTagStr(t) {
  const w = Math.round(t.weight * 100) / 100;
  if (w === 1) return t.text;
  if (w === 1.1) return `(${t.text})`;
  return `(${t.text}:${formatWeight(w)})`;
}

function parsePillText(text) {
  const lines = (text || "").split("\n");
  const out = [];
  lines.forEach((line, li) => {
    line
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length)
      .forEach((p) => {
        const withWeight = p.match(/^\((.+):([0-9.]+)\)$/);
        if (withWeight) {
          out.push(makePillTag(withWeight[1].trim(), parseFloat(withWeight[2])));
          return;
        }
        // "(태그)" 형태(콜론+숫자 없이 괄호만)는 "(태그:1.1)"과 동일한 가중치로 취급한다.
        const plainWrapped = p.match(/^\((.+)\)$/);
        if (plainWrapped) {
          out.push(makePillTag(plainWrapped[1].trim(), 1.1));
          return;
        }
        out.push(makePillTag(p, 1));
      });
    if (li < lines.length - 1) out.push(makePillBreak());
  });
  return out;
}

function serializePillsToText(list) {
  let out = "";
  let line = [];
  list.forEach((t) => {
    if (t.type === "break") {
      out += line.join(", ") + "\n";
      line = [];
    } else {
      line.push(pillTagStr(t));
    }
  });
  return out + line.join(", ");
}

function serializePillsToComfy(list) {
  return list
    .filter((t) => t.type === "tag")
    .map(pillTagStr)
    .join(", ");
}

// ============================================================
// 공유 모드 전환 상태 - 긍정/부정 프롬프트가 함께 텍스트/태그 모드를 바꾼다.
// ============================================================
let sharedPromptMode = "text";
const promptPillControllers = {};

function toggleSharedPromptMode() {
  sharedPromptMode = sharedPromptMode === "text" ? "pill" : "text";
  document.querySelectorAll(".shared-prompt-mode-btn").forEach((btn) => {
    btn.style.color = sharedPromptMode === "pill" ? "var(--fill-brand)" : "var(--text-secondary)";
  });
  Object.values(promptPillControllers).forEach((c) => c.applyMode());
}

function initSharedPromptModeToggle() {
  const btn = document.getElementById("promptModeToggleBtn");
  btn.classList.add("shared-prompt-mode-btn");
  btn.addEventListener("click", toggleSharedPromptMode);
}

// 긍정/부정 프롬프트가 각각 따로가 아니라 같은 토글 안에서, 다만 서로 다른 박스로 보여준다.
function updateSharedPreview() {
  const posBox = document.getElementById("positivePreviewBox");
  const negBox = document.getElementById("negativePreviewBox");
  if (posBox) posBox.textContent = (promptPillControllers.positive ? promptPillControllers.positive.getComfyText() : "") || "(비어있음)";
  if (negBox) negBox.textContent = (promptPillControllers.negative ? promptPillControllers.negative.getComfyText() : "") || "(비어있음)";
}

function initSharedPreviewToggle() {
  const toggle = document.getElementById("sharedPreviewToggle");
  const wrap = document.getElementById("sharedPreviewWrap");
  toggle.addEventListener("click", () => {
    const isOpen = wrap.style.display === "flex";
    wrap.style.display = isOpen ? "none" : "flex";
    if (!isOpen) updateSharedPreview();
  });
}

function initPromptPillEditor(prefix, isNegative) {
  const textarea = document.getElementById(`${prefix}Prompt`);
  const promptWrap = textarea.closest(".prompt-wrap");
  const pillBox = document.getElementById(`${prefix}PillBox`);
  const promptLabel = document.getElementById(`${prefix}PromptLabel`);
  const promptSection = document.getElementById(`${prefix}PromptSection`);
  const chevron = document.getElementById(`${prefix}Chevron`);

  let tags = [];
  let openIdx = null;

  function updatePreview() {
    updateSharedPreview();
  }

  function syncTagsFromTextarea() {
    tags = parsePillText(textarea.value);
    updatePreview();
  }

  // 지금 화면에 어느 모드가 보이는지와 무관하게, textarea 의 실제 값을
  // 현재 태그 상태로 맞춰준다. 생성 버튼을 누르기 직전에 반드시 호출해서,
  // 태그 모드에서 수정한 내용이 텍스트 모드로 돌아가지 않아도 반영되게 한다.
  function syncToTextarea() {
    if (sharedPromptMode === "pill") {
      textarea.value = serializePillsToText(tags);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function renderTextFromTags() {
    textarea.value = serializePillsToText(tags);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    updatePreview();
  }

  function syncTagsFromDom() {
    tags = Array.from(pillBox.children)
      .map((el) => el._tagRef)
      .filter(Boolean);
    updatePreview();
  }

  function renderEditorBlock(t, idx, color, pillEl) {
    const wrap = document.createElement("div");
    wrap.className = "prompt-pill-editor-block";
    wrap.style.borderColor = color || "var(--border)";
    wrap.innerHTML = `
      <div class="prompt-pill-editor-top">
        <button type="button" class="prompt-pill-btn pill-minus">−</button>
        <span class="prompt-pill-editor-weight" style="color:${color || "var(--text-primary)"};">${formatWeight(t.weight)}</span>
        <button type="button" class="prompt-pill-btn pill-plus">+</button>
        <input type="range" class="prompt-pill-editor-slider pill-weight-slider" min="0.1" max="2" step="0.05" value="${t.weight}">
        <button type="button" class="prompt-pill-btn pill-weight-reset" aria-label="가중치 초기화"><i class="ti ti-refresh" aria-hidden="true"></i></button>
        <button type="button" class="prompt-pill-editor-delete pill-delete" aria-label="삭제"><i class="ti ti-trash" aria-hidden="true"></i></button>
        <button type="button" class="prompt-pill-editor-cancel pill-confirm" aria-label="확인"><i class="ti ti-check" aria-hidden="true"></i></button>
      </div>
      <div class="prompt-pill-input-wrap">
        <input type="text" class="prompt-pill-editor-input pill-word-input" value="${t.text}" placeholder="태그 입력">
        <button type="button" class="prompt-pill-input-reset pill-text-reset" aria-label="텍스트 초기화"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="prompt-pill-ac"></div>`;

    wrap.querySelector(".pill-weight-reset").addEventListener("click", () => {
      t.weight = 1;
      refreshWeightDisplay();
    });
    wrap.querySelector(".pill-text-reset").addEventListener("click", () => {
      const wordInput = wrap.querySelector(".pill-word-input");
      wordInput.value = "";
      t.text = "";
      pillEl.querySelector(".prompt-pill-text").textContent = "";
      updatePreview();
      wordInput.focus();
    });

    const slider = wrap.querySelector(".pill-weight-slider");
    function refreshWeightDisplay() {
      wrap.querySelector(".prompt-pill-editor-weight").textContent = formatWeight(t.weight);
      slider.value = t.weight;
      const pillWeightSpan = pillEl.querySelector(".prompt-pill-weight");
      const wordInput = wrap.querySelector(".pill-word-input");
      const weightLabel = wrap.querySelector(".prompt-pill-editor-weight");
      if (Math.abs(t.weight - 1) < 0.001) {
        if (pillWeightSpan) pillWeightSpan.remove();
        pillEl.style.removeProperty("--pill-border");
        pillEl.style.removeProperty("--pill-glow");
        wrap.style.borderColor = "var(--border)";
        wordInput.style.borderColor = "var(--border)";
        weightLabel.style.color = "var(--text-primary)";
      } else {
        const c = pillWeightColor(t.weight, isNegative);
        pillEl.style.setProperty("--pill-border", c);
        pillEl.style.setProperty("--pill-glow", c);
        wrap.style.borderColor = c;
        wordInput.style.borderColor = c;
        weightLabel.style.color = c;
        if (pillWeightSpan) {
          pillWeightSpan.style.color = c;
          pillWeightSpan.textContent = formatWeight(t.weight);
        } else {
          const span = document.createElement("span");
          span.className = "prompt-pill-weight";
          span.style.color = c;
          span.textContent = formatWeight(t.weight);
          pillEl.appendChild(span);
        }
      }
      updatePreview();
    }
    wrap.querySelector(".pill-minus").addEventListener("click", () => {
      t.weight = Math.max(0.1, Math.round((t.weight - 0.05) * 100) / 100);
      refreshWeightDisplay();
    });
    wrap.querySelector(".pill-plus").addEventListener("click", () => {
      t.weight = Math.min(2, Math.round((t.weight + 0.05) * 100) / 100);
      refreshWeightDisplay();
    });
    slider.addEventListener("input", () => {
      t.weight = parseFloat(slider.value);
      refreshWeightDisplay();
    });

    const weightSpan = wrap.querySelector(".prompt-pill-editor-weight");
    weightSpan.style.cursor = "pointer";
    weightSpan.title = "눌러서 직접 입력";
    weightSpan.addEventListener("click", () => {
      const numInput = document.createElement("input");
      numInput.type = "number";
      numInput.step = "0.05";
      numInput.value = t.weight;
      numInput.style.cssText = "width:52px; font-size:12px; font-weight:500; text-align:center; margin:0; padding:2px 4px;";
      weightSpan.replaceWith(numInput);
      numInput.focus();
      numInput.select();

      function commit() {
        let v = parseFloat(numInput.value);
        if (isNaN(v)) v = t.weight;
        v = Math.min(2, Math.max(0.1, Math.round(v * 100) / 100));
        t.weight = v;
        numInput.replaceWith(weightSpan);
        refreshWeightDisplay();
      }
      numInput.addEventListener("blur", commit);
      numInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      });
    });
    wrap.querySelector(".pill-delete").addEventListener("click", () => {
      tags.splice(idx, 1);
      openIdx = null;
      renderPills();
    });
    wrap.querySelector(".pill-confirm").addEventListener("click", () => {
      openIdx = null;
      renderPills();
    });

    const input = wrap.querySelector(".pill-word-input");
    const acList = wrap.querySelector(".prompt-pill-ac");
    let acDebounce = null;

    async function updateAc() {
      const q = input.value.trim();
      if (!q) {
        acList.style.display = "none";
        acList.innerHTML = "";
        return;
      }
      try {
        const items = await fetchTagSuggestions(q, 6);
        if (input.value.trim() !== q) return;
        renderTagSuggestionList(acList, items, (tag) => {
          t.text = fmtTagName(tag.en);
          input.value = t.text;
          pillEl.querySelector(".prompt-pill-text").textContent = t.text;
          updatePreview();
          acList.style.display = "none";
          acList.innerHTML = "";
        });
      } catch (e) {
        acList.style.display = "none";
        acList.innerHTML = "";
      }
    }

    input.addEventListener("input", () => {
      t.text = input.value;
      pillEl.querySelector(".prompt-pill-text").textContent = t.text;
      updatePreview();
      clearTimeout(acDebounce);
      acDebounce = setTimeout(updateAc, 200);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!input.value.trim()) {
          tags.splice(idx, 1, makePillBreak());
          openIdx = null;
          renderPills();
          return;
        }
        t.text = input.value;
        openIdx = null;
        renderPills();
      }
    });
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
    return wrap;
  }

  // 손잡이 없이: 짧게 탭하면 편집, 0.35초 이상 꾹 누르고 있으면(많이 움직이지 않았을 때)
  // 알약이 떠올라서 손가락을 따라다니고, 지나가는 자리에 빈 칸(placeholder)이 벌어진다.
  function enablePressDrag(pill, idx) {
    let pressTimer = null;
    let dragging = false;
    let startX = 0, startY = 0, offsetX = 0, offsetY = 0;
    let placeholder = null;
    const LONG_PRESS_MS = 350;
    const MOVE_TOLERANCE = 8;

    pill.addEventListener("pointerdown", (e) => {
      startX = e.clientX;
      startY = e.clientY;
      dragging = false;
      pressTimer = setTimeout(() => {
        dragging = true;
        const rect = pill.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;

        placeholder = document.createElement("div");
        placeholder.className = "prompt-pill-placeholder";
        placeholder.style.width = `${rect.width}px`;
        placeholder.style.height = `${rect.height}px`;
        pill.parentNode.insertBefore(placeholder, pill);

        pill.setPointerCapture(e.pointerId);
        pill.style.position = "fixed";
        pill.style.left = `${rect.left}px`;
        pill.style.top = `${rect.top}px`;
        pill.style.width = `${rect.width}px`;
        pill.style.margin = "0";
        pill.style.zIndex = "999";
        pill.style.pointerEvents = "none";
        pill.style.transform = "scale(1.06)";
      }, LONG_PRESS_MS);
    });

    pill.addEventListener("pointermove", (e) => {
      if (!dragging) {
        if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE) {
          clearTimeout(pressTimer);
        }
        return;
      }
      pill.style.left = `${e.clientX - offsetX}px`;
      pill.style.top = `${e.clientY - offsetY}px`;

      const target = document.elementFromPoint(e.clientX, e.clientY);
      const targetPill = target && target.closest(".prompt-pill");
      if (targetPill && targetPill !== pill && pillBox.contains(targetPill)) {
        const rect = targetPill.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        // 줄바꿈 칩 바로 뒤에는 놓을 수 없게 한다 (그 뒤는 다음 줄로 넘어가는 자리라 어색해짐)
        if (targetPill.classList.contains("prompt-pill-break-chip") && !before) {
          // no-op: 이번 이동은 무시하고 이전 위치를 유지
        } else {
          pillBox.insertBefore(placeholder, before ? targetPill : targetPill.nextSibling);
        }
      } else if (target === pillBox) {
        pillBox.appendChild(placeholder);
      }
      // 태그 추가(+) 버튼 뒤에는 절대 놓일 수 없도록, 매 이동마다 + 버튼을 맨 뒤로 다시 고정한다.
      const addBtn = pillBox.querySelector(".prompt-pill-add-trailing");
      if (addBtn) pillBox.appendChild(addBtn);
    });

    function endPress(e) {
      clearTimeout(pressTimer);
      if (dragging) {
        pill.style.position = "";
        pill.style.left = "";
        pill.style.top = "";
        pill.style.width = "";
        pill.style.margin = "";
        pill.style.zIndex = "";
        pill.style.pointerEvents = "";
        pill.style.transform = "";
        try {
          pill.releasePointerCapture(e.pointerId);
        } catch (err) {}
        placeholder.parentNode.insertBefore(pill, placeholder);
        placeholder.remove();
        placeholder = null;
        dragging = false;
        syncTagsFromDom();
        renderPills();
      } else {
        openIdx = openIdx === idx ? null : idx;
        renderPills();
      }
    }
    pill.addEventListener("pointerup", endPress);
    pill.addEventListener("pointercancel", () => {
      clearTimeout(pressTimer);
      if (dragging && placeholder) {
        pill.style.position = "";
        pill.style.left = "";
        pill.style.top = "";
        pill.style.width = "";
        pill.style.margin = "";
        pill.style.zIndex = "";
        pill.style.pointerEvents = "";
        pill.style.transform = "";
        placeholder.parentNode.insertBefore(pill, placeholder);
        placeholder.remove();
        placeholder = null;
      }
      dragging = false;
    });
  }

  function makeAddBtn(onClick, label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "prompt-pill-add";
    btn.setAttribute("aria-label", label || "태그 추가");
    btn.innerHTML = '<i class="ti ti-plus" aria-hidden="true" style="font-size:14px;"></i>';
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderPills() {
    pillBox.innerHTML = "";
    tags.forEach((t, i) => {
      if (t.type === "break") {
        const chip = document.createElement("button");
        chip._tagRef = t;
        chip.type = "button";
        chip.className = "prompt-pill prompt-pill-break-chip";
        chip.setAttribute("aria-label", "줄바꿈 삭제");
        chip.innerHTML = '<i class="ti ti-corner-down-left" aria-hidden="true"></i>';
        chip.addEventListener("click", () => {
          tags.splice(i, 1);
          renderPills();
        });
        pillBox.appendChild(chip);

        const spacer = document.createElement("div");
        spacer.style.cssText = "flex-basis:100%; height:0;";
        pillBox.appendChild(spacer);
        return;
      }
      const color = pillWeightColor(t.weight, isNegative);

      if (openIdx === i) {
        pillBox.appendChild(
          makeAddBtn(() => {
            tags.splice(i, 0, makePillTag("", 1));
            openIdx = i;
            renderPills();
          }, "이 태그 앞에 추가")
        );
      }

      const pill = document.createElement("div");
      pill._tagRef = t;
      pill.className = "prompt-pill" + (openIdx === i ? " selected" : "");
      if (color) {
        pill.style.setProperty("--pill-border", color);
        pill.style.setProperty("--pill-glow", color);
      }
      pill.innerHTML =
        `<span class="prompt-pill-text">${t.text}</span>` +
        (color ? `<span class="prompt-pill-weight" style="color:${color};">${formatWeight(t.weight)}</span>` : "");
      pillBox.appendChild(pill);
      enablePressDrag(pill, i);

      if (openIdx === i) {
        pillBox.appendChild(
          makeAddBtn(() => {
            tags.splice(i + 1, 0, makePillTag("", 1));
            openIdx = i + 1;
            renderPills();
          }, "이 태그 뒤에 추가")
        );
        pillBox.appendChild(renderEditorBlock(t, i, color, pill));
      }
    });

    pillBox.appendChild(
      makeAddBtn(() => {
        tags.push(makePillTag("", 1));
        openIdx = tags.length - 1;
        renderPills();
      })
    );
    pillBox.lastChild.classList.add("prompt-pill-add-trailing");

    updatePreview();
  }

  function applyMode() {
    if (sharedPromptMode === "pill") {
      syncTagsFromTextarea();
      promptWrap.style.display = "none";
      pillBox.style.display = "flex";
      renderPills();
    } else {
      openIdx = null;
      promptWrap.style.display = "block";
      pillBox.style.display = "none";
      renderTextFromTags();
    }
  }

  textarea.addEventListener("input", () => {
    if (sharedPromptMode === "text") syncTagsFromTextarea();
  });

  // (미리보기 토글은 이제 하나로 합쳐져 initSharedPromptModeToggle 근처에서 별도로 초기화됨)

  let collapsed = false;
  if (promptLabel && promptSection && chevron) {
    promptLabel.addEventListener("click", () => {
      collapsed = !collapsed;
      promptSection.style.display = collapsed ? "none" : "block";
      chevron.style.transform = collapsed ? "rotate(-90deg)" : "rotate(0deg)";
    });
  }

  syncTagsFromTextarea();
  promptPillControllers[prefix] = {
    applyMode,
    syncToTextarea,
    getComfyText: () => serializePillsToComfy(tags),
    // applyState() 등 외부에서 textarea.value 를 이벤트 없이 직접 바꿨을 때(계열 전환 등)
    // 태그 모드의 내부 상태가 낡은 채로 남지 않도록 강제로 다시 읽어들인다.
    forceSync: () => {
      syncTagsFromTextarea();
      if (sharedPromptMode === "pill") renderPills();
    },
  };
}

function initInlinePromptAutocomplete(textareaId, dropdownId) {
  const textarea = document.getElementById(textareaId);
  const dropdown = document.getElementById(dropdownId);
  let debounceTimer = null;

  function positionDropdown() {
    const coords = getCaretCoords(textarea, textarea.selectionStart);
    dropdown.style.top = `${textarea.offsetTop + coords.top + coords.height - textarea.scrollTop + 2}px`;
    dropdown.style.left = `${textarea.offsetLeft + coords.left}px`;
  }

  function render(items) {
    positionDropdown();
    renderTagSuggestionList(dropdown, items, selectSuggestion);
  }

  function selectSuggestion(tag) {
    const seg = getPromptSegment(textarea);
    const before = textarea.value.slice(0, seg.start);
    const after = textarea.value.slice(seg.end);
    const needsSpace = before.trim().endsWith(",") && !/\s$/.test(before);
    const insertion = `${needsSpace ? " " : ""}${fmtTagName(tag.en)}, `;
    textarea.value = before + insertion + after.replace(/^[^\S\n]+/, "");
    const newPos = (before + insertion).length;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    textarea.setSelectionRange(newPos, newPos);
    dropdown.style.display = "none";
  }

  async function check() {
    const seg = getPromptSegment(textarea);
    if (!seg.text) {
      dropdown.style.display = "none";
      return;
    }
    try {
      const items = await fetchTagSuggestions(seg.text, 8);
      // 응답 도착 전 커서가 다른 단어로 옮겨갔으면 그 결과는 버린다.
      if (getPromptSegment(textarea).text === seg.text) render(items);
    } catch (e) {
      dropdown.style.display = "none";
    }
  }

  function onActivity() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(check, 200);
  }

  textarea.addEventListener("input", (e) => {
    if (!e.isTrusted) return; // 모드 전환 등으로 프로그램이 직접 값을 바꾼 경우는 무시
    onActivity();
  });
  textarea.addEventListener("click", onActivity);
  textarea.addEventListener("keyup", onActivity);
  textarea.addEventListener("blur", () => {
    setTimeout(() => { dropdown.style.display = "none"; }, 150);
  });
}

function initTagSearch() {
  const openBtn = document.getElementById("openTagSearchBtn");
  const backdrop = document.getElementById("tagOverlayBackdrop");
  const panel = document.getElementById("tagOverlayPanel");
  const input = document.getElementById("tagOverlayInput");
  const posBtn = document.getElementById("tagOverlayAddPos");
  const negBtn = document.getElementById("tagOverlayAddNeg");
  const selectedRow = document.getElementById("tagOverlaySelectedRow");
  const list = document.getElementById("tagOverlayList");
  const toast = document.getElementById("tagToast");

  let lockedScrollY = 0;

  function openOverlay() {
    backdrop.classList.add("open");
    panel.classList.add("open");
    lockedScrollY = window.scrollY;
    document.documentElement.classList.add("scroll-locked");
    document.body.classList.add("scroll-locked");
    document.body.style.top = `-${lockedScrollY}px`;
    input.value = "";
    clearSelection();
    renderList([]);
    setTimeout(() => input.focus(), 50);
  }
  function closeOverlay() {
    backdrop.classList.remove("open");
    panel.classList.remove("open");
    document.documentElement.classList.remove("scroll-locked");
    document.body.classList.remove("scroll-locked");
    document.body.style.top = "";
    window.scrollTo(0, lockedScrollY);
  }
  function clearSelection() {
    selectedTag = null;
    selectedRow.innerHTML = "";
    [posBtn, negBtn].forEach((b) => {
      b.disabled = true;
      b.classList.remove("enabled");
    });
    list.querySelectorAll(".tag-result-item.selected").forEach((el) => el.classList.remove("selected"));
  }
  function selectTagRow(tag, el) {
    selectedTag = tag;
    list.querySelectorAll(".tag-result-item.selected").forEach((n) => n.classList.remove("selected"));
    el.classList.add("selected");
    selectedRow.innerHTML = `선택된 태그: <span class="tag-chip">${fmtTagName(tag.en)}</span>`;
    posBtn.disabled = false;
    negBtn.disabled = false;
    posBtn.classList.add("enabled");
    negBtn.classList.add("enabled");
  }
  function renderList(items) {
    if (!items.length) {
      list.innerHTML = '<div class="tag-empty">검색어를 입력하면 태그가 여기에 표시됩니다</div>';
      return;
    }
    list.innerHTML = items
      .map(
        (t, i) => `
      <div class="tag-result-item" data-idx="${i}">
        <div class="tag-result-top">
          <span class="tag-result-en">${fmtTagName(t.en)}</span>
          <span class="tag-result-kr">${t.kr}</span>
          <span class="tag-result-count">${t.count || ""}</span>
        </div>
        <p class="tag-result-desc">${t.desc || ""}</p>
      </div>`
      )
      .join("");
    list._items = items;
    list.querySelectorAll(".tag-result-item").forEach((el) => {
      el.addEventListener("click", () => selectTagRow(list._items[parseInt(el.dataset.idx, 10)], el));
    });
  }
  async function filterTags() {
    const q = input.value.trim();
    clearSelection();
    if (!q) {
      renderList([]);
      return;
    }
    try {
      const res = await fetch(`/api/tags/autocomplete?q=${encodeURIComponent(q)}`);
      const items = await res.json();
      // 응답이 오는 동안 검색어가 바뀌었으면 그 결과는 버린다.
      if (input.value.trim() === q) renderList(items);
    } catch (e) {
      list.innerHTML = '<div class="tag-empty">검색에 실패했습니다. 서버 연결을 확인해주세요.</div>';
    }
  }
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove("show"), 1400);
  }
  function addSelectedTag(targetId, label) {
    if (!selectedTag) return;
    const textarea = document.getElementById(targetId);
    const current = textarea.value.trim();
    const tagText = fmtTagName(selectedTag.en);
    textarea.value = current ? `${current}, ${tagText}` : tagText;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    // 지금 태그 모드로 보이는 중이었다면, textarea에 쓴 내용이 알약 목록에도 즉시 반영되게 한다.
    const prefix = targetId === "positivePrompt" ? "positive" : "negative";
    if (promptPillControllers[prefix]) promptPillControllers[prefix].forceSync();

    showToast(`${label} 프롬프트에 "${tagText}" 추가됨`);

    input.value = "";
    clearSelection();
    renderList([]);
    input.focus();
  }

  openBtn.addEventListener("click", openOverlay);
  document.getElementById("tagOverlayCloseBtn").addEventListener("click", closeOverlay);
  backdrop.addEventListener("click", closeOverlay);
  input.addEventListener("input", () => {
    clearTimeout(tagSearchDebounce);
    tagSearchDebounce = setTimeout(filterTags, 200);
  });
  posBtn.addEventListener("click", () => addSelectedTag("positivePrompt", "긍정"));
  negBtn.addEventListener("click", () => addSelectedTag("negativePrompt", "부정"));
}

let loraCount = 0;
let currentFam = "anima";

// ---------- LoRA 행 ----------

function loraRowHtml() {
  return `
    <div class="lora-row">
      <div class="row-top">
        <span class="lora-order">1</span>
        <button class="lora-handle" aria-label="드래그하여 순서 변경" type="button">⋮⋮</button>
        <div class="searchable-select" style="flex:1; min-width:0; margin-top:0;">
          <input type="text" class="searchable-display" placeholder="LoRA 검색..." autocomplete="off" style="font-size:12px;">
          <input type="hidden" class="lora-select">
          <div class="searchable-dropdown"></div>
        </div>
        <button class="lora-info-btn model-info-btn" aria-label="LoRA 정보 보기" type="button">
          <i class="ti ti-info-circle" aria-hidden="true"></i>
        </button>
        <button class="lora-text-btn lora-advanced-btn" type="button">고급</button>
        <button class="lora-remove-btn" aria-label="LoRA 제거" type="button">✕</button>
      </div>
      <div class="lora-simple">
        <span class="lora-strength-label" style="min-width:32px;">강도</span>
        <input type="range" class="lora-strength" min="0" max="2" step="0.05" value="1">
        <span class="lora-strength-out">1.00</span>
      </div>
      <div class="lora-advanced-panel">
        <div class="lora-advanced-row">
          <span class="lora-strength-label">model 강도</span>
          <input type="range" class="lora-strength-model" min="0" max="2" step="0.05" value="1">
          <span class="lora-model-out lora-strength-out">1.00</span>
        </div>
        <div class="lora-advanced-row">
          <span class="lora-strength-label">clip 강도</span>
          <input type="range" class="lora-strength-clip" min="0" max="2" step="0.05" value="1">
          <span class="lora-clip-out lora-strength-out">1.00</span>
        </div>
      </div>
    </div>`;
}

function renumberLoras() {
  document.querySelectorAll("#loraList .lora-row").forEach((row, i) => {
    row.querySelector(".lora-order").textContent = i + 1;
  });
}

function enableDrag(row) {
  const handle = row.querySelector(".lora-handle");
  const list = document.getElementById("loraList");

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    let refY = e.clientY;
    row.style.position = "relative";
    row.style.zIndex = "5";
    row.style.borderColor = "var(--border-strong)";

    function onMove(ev) {
      const dy = ev.clientY - refY;
      row.style.transform = `translateY(${dy}px)`;
      const rowRect = row.getBoundingClientRect();
      const rowMid = rowRect.top + rowRect.height / 2;
      const next = row.nextElementSibling;
      const prev = row.previousElementSibling;

      if (dy > 0 && next) {
        const r = next.getBoundingClientRect();
        if (rowMid > r.top + r.height / 2) {
          list.insertBefore(next, row);
          refY = ev.clientY;
          row.style.transform = "translateY(0px)";
          renumberLoras();
        }
      } else if (dy < 0 && prev) {
        const r = prev.getBoundingClientRect();
        if (rowMid < r.top + r.height / 2) {
          list.insertBefore(row, prev);
          refY = ev.clientY;
          row.style.transform = "translateY(0px)";
          renumberLoras();
        }
      }
    }

    function onUp() {
      row.style.transform = "";
      row.style.zIndex = "";
      row.style.position = "";
      row.style.borderColor = "transparent";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      saveNow();
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

// data 를 넘기면 그 값으로 행을 채우고(저장된 상태 복원용),
// 넘기지 않으면 기본값(강도 1.00, 첫번째 LoRA)으로 새 행을 만듭니다.
function addLora(data) {
  loraCount++;
  const list = document.getElementById("loraList");
  const wrapper = document.createElement("div");
  wrapper.innerHTML = loraRowHtml();
  const row = wrapper.firstElementChild;
  list.appendChild(row);

  const selectEl = row.querySelector(".lora-select");
  setSearchableOptions(selectEl, optionsWithStrippedLabels(modelsCache[currentFam].loras, "lora", currentFam));
  initPathPickerTrigger(selectEl, "lora", "LoRA 선택");

  const simple = row.querySelector(".lora-simple");
  const advPanel = row.querySelector(".lora-advanced-panel");
  const advBtn = row.querySelector(".lora-advanced-btn");
  const range = row.querySelector(".lora-strength");
  const out = row.querySelector(".lora-strength-out");
  const modelRange = row.querySelector(".lora-strength-model");
  const modelOut = row.querySelector(".lora-model-out");
  const clipRange = row.querySelector(".lora-strength-clip");
  const clipOut = row.querySelector(".lora-clip-out");

  let advancedOn = false;

  if (data) {
    if (data.file) setSearchableValue(selectEl, data.file);
    const sm = data.strengthModel !== undefined ? parseFloat(data.strengthModel) : 1;
    const sc = data.strengthClip !== undefined ? parseFloat(data.strengthClip) : 1;
    setRangeValue(range, sm);
    setRangeValue(modelRange, sm);
    setRangeValue(clipRange, sc);
    out.textContent = sm.toFixed(2);
    modelOut.textContent = sm.toFixed(2);
    clipOut.textContent = sc.toFixed(2);
    if (data.advanced) {
      advancedOn = true;
      advPanel.style.display = "flex";
      simple.style.display = "none";
      advBtn.classList.add("active");
    }
  }

  row.querySelector(".lora-remove-btn").addEventListener("click", () => {
    row.remove();
    renumberLoras();
    saveNow();
  });

  advBtn.addEventListener("click", () => {
    advancedOn = !advancedOn;
    advPanel.style.display = advancedOn ? "flex" : "none";
    simple.style.display = advancedOn ? "none" : "flex";
    advBtn.classList.toggle("active", advancedOn);
    saveNow();
  });

  range.addEventListener("input", () => {
    out.textContent = parseFloat(range.value).toFixed(2);
    setRangeValue(modelRange, range.value);
    setRangeValue(clipRange, range.value);
    modelOut.textContent = parseFloat(modelRange.value).toFixed(2);
    clipOut.textContent = parseFloat(clipRange.value).toFixed(2);
  });
  modelRange.addEventListener("input", () => {
    modelOut.textContent = parseFloat(modelRange.value).toFixed(2);
  });
  clipRange.addEventListener("input", () => {
    clipOut.textContent = parseFloat(clipRange.value).toFixed(2);
  });
  makeEditableSliderOutput(range, out, 2);
  makeEditableSliderOutput(modelRange, modelOut, 2);
  makeEditableSliderOutput(clipRange, clipOut, 2);

  enableDrag(row);
  renumberLoras();
  return row;
}

// ---------- 체크포인트 / 모델 계열 ----------

function updateCkptSection() {
  document.getElementById("ckptLabelText").textContent =
    currentFam === "anima" ? "UNET 모델" : "체크포인트";
  setSearchableOptions(document.getElementById("ckptSelect"), optionsWithStrippedLabels(modelsCache[currentFam].checkpoints, "checkpoint", currentFam));
}

function updateAdvancedSection() {
  const clipRow = document.getElementById("animaClipRow");
  const vaeSelect = document.getElementById("vaeSelect");
  const clipSkipSection = document.getElementById("clipSkipSection");

  if (currentFam === "anima") {
    clipRow.style.display = "block";
    setSearchableOptions(document.getElementById("clipSelect"), modelsCache.anima.clips || []);
    setSearchableOptions(vaeSelect, modelsCache.anima.vaes || []);

    // Anima는 CLIP 구조가 달라 CLIP 스킵을 지원하지 않음
    clipSkipSection.style.display = "none";
    document.getElementById("clipSkipToggle").classList.remove("active");
    document.getElementById("clipSkipRow").style.display = "none";
    document.getElementById("clipSkipInput").value = "";
  } else {
    clipRow.style.display = "none";
    setSearchableOptions(vaeSelect, [
      { value: "", label: "기본값 (체크포인트 내장 VAE)" },
      ...(modelsCache.il.vaes || []).map((v) => ({ value: v, label: v })),
    ]);
    clipSkipSection.style.display = "block";
  }
}

// ============================================================
// 필터링 키워드 설정(체크포인트/LoRA 공용) - 서버에 저장된 커스텀 키워드(계열별)를
// 불러오고, 톱니바퀴로 편집/적용한다. 비워두면 기본값(계열 이름)을 쓰고,
// "필터링 사용 안함"을 누르면 그 계열은 전체 목록을 다 보여준다.
// "일괄 적용"을 누르면 체크포인트/LoRA 필터를 동시에 같은 키워드로 맞춘다.
// ============================================================

const filterState = {
  lora: { anima: { keywords: [], disabled: false }, il: { keywords: [], disabled: false } },
  checkpoint: { anima: { keywords: [], disabled: false }, il: { keywords: [], disabled: false } },
  defaults: { anima: ["ANIMA"], il: ["IL"] },
};

function refreshFilterDisplay(kind) {
  const display = document.getElementById(`${kind === "lora" ? "lora" : "ckpt"}FilterDisplay`);
  const entry = filterState[kind][currentFam] || { keywords: [], disabled: false };
  const def = filterState.defaults[currentFam] || [];
  if (entry.disabled) {
    display.textContent = "필터링 사용 안함";
  } else if (entry.keywords && entry.keywords.length) {
    display.textContent = entry.keywords.join(", ");
  } else {
    display.textContent = `${def.join(", ")} (기본값)`;
  }
}

function refreshAllFilterDisplays() {
  refreshFilterDisplay("lora");
  refreshFilterDisplay("checkpoint");
}

// 필터가 바뀌었을 때, 이미 화면에 떠 있는 각 LoRA 행의 드롭다운 목록(옵션 자체)을
// modelsCache의 최신 값으로 강제로 다시 채운다. (행 생성 시점에 고정된 목록이라
// loadModels()로 캐시만 갱신해서는 화면에 반영되지 않기 때문)
function refreshAllLoraRowOptions() {
  document.querySelectorAll("#loraList .lora-row").forEach((row) => {
    const selectEl = row.querySelector(".lora-select");
    if (selectEl) setSearchableOptions(selectEl, optionsWithStrippedLabels(modelsCache[currentFam].loras, "lora", currentFam));
  });
}

// 체크포인트 select는 화면에 하나뿐이라 그냥 다시 채우면 된다.
function refreshCkptSelectOptions() {
  setSearchableOptions(document.getElementById("ckptSelect"), optionsWithStrippedLabels(modelsCache[currentFam].checkpoints, "checkpoint", currentFam));
}

async function initFilterSettingsPanel(kind) {
  const prefix = kind === "lora" ? "lora" : "ckpt";
  const gearBtn = document.getElementById(`${prefix}FilterGearBtn`);
  const panel = document.getElementById(`${prefix}FilterPanel`);
  const input = document.getElementById(`${prefix}FilterInput`);
  const defaultHint = document.getElementById(`${prefix}FilterDefaultHint`);
  const disableBtn = document.getElementById(`${prefix}FilterDisableBtn`);
  const applyBtn = document.getElementById(`${prefix}FilterApplyBtn`);
  const applyBothBtn = document.getElementById(`${prefix}FilterApplyBothBtn`);
  const cancelBtn = document.getElementById(`${prefix}FilterCancelBtn`);

  try {
    const res = await fetch(`/api/filter-settings/${kind}`);
    const data = await res.json();
    filterState[kind].anima = data.anima;
    filterState[kind].il = data.il;
    if (data.defaults) filterState.defaults = data.defaults;
  } catch (e) {
    /* 서버에서 못 가져오면 기본값만 있는 상태로 둔다 */
  }
  refreshFilterDisplay(kind);

  async function persist(entry, kindsToApply) {
    try {
      const res = await fetch(`/api/filter-settings/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [currentFam]: entry, kinds: kindsToApply }),
      });
      const data = await res.json();
      filterState[kind].anima = data.anima;
      filterState[kind].il = data.il;
      // 일괄 적용이었다면, 반대쪽 종류도 서버에서 같은 값으로 저장됐으니 다시 받아온다.
      if (kindsToApply && kindsToApply.length > 1) {
        const otherKind = kind === "lora" ? "checkpoint" : "lora";
        const otherRes = await fetch(`/api/filter-settings/${otherKind}`);
        const otherData = await otherRes.json();
        filterState[otherKind].anima = otherData.anima;
        filterState[otherKind].il = otherData.il;
      }
    } catch (e) {
      /* 저장 실패 시에도 화면은 방금 입력한 값으로 갱신해서 UX를 막지 않는다 */
      filterState[kind][currentFam] = entry;
    }
    panel.style.display = "none";
    refreshAllFilterDisplays();
    await loadModels(); // 필터가 바뀌었으니 캐시를 새로 받아오고
    refreshAllLoraRowOptions();
    refreshCkptSelectOptions();
  }

  gearBtn.addEventListener("click", () => {
    const entry = filterState[kind][currentFam] || { keywords: [], disabled: false };
    const def = filterState.defaults[currentFam] || [];
    input.value = (entry.keywords || []).join(", ");
    defaultHint.textContent = `비워두면 기본값(${def.join(", ")})을 사용합니다.`;
    panel.style.display = panel.style.display === "block" ? "none" : "block";
  });

  cancelBtn.addEventListener("click", () => {
    panel.style.display = "none";
  });

  applyBtn.addEventListener("click", async () => {
    const raw = input.value.trim();
    const keywords = raw ? raw.split(",").map((k) => k.trim()).filter((k) => k.length) : [];
    await persist({ keywords, disabled: false }, [kind]);
  });

  applyBothBtn.addEventListener("click", async () => {
    const raw = input.value.trim();
    const keywords = raw ? raw.split(",").map((k) => k.trim()).filter((k) => k.length) : [];
    await persist({ keywords, disabled: false }, ["lora", "checkpoint"]);
  });

  disableBtn.addEventListener("click", async () => {
    await persist({ keywords: [], disabled: true }, [kind]);
  });
}

async function initLoraFilterSettings() {
  await initFilterSettingsPanel("lora");
  await initFilterSettingsPanel("checkpoint");
}


// ============================================================
// 체크포인트/LoRA 경로 피커 - 필터 접두사를 뗀 경로("대분류\소분류\파일")를
// 빵부스러기 태그로 드릴다운해서 탐색한다. 검색창에 입력하면 카테고리 무시하고
// 전체에서 부분일치 검색으로 전환된다. 체크포인트/LoRA 행 전체가 이 오버레이
// 하나를 공유하고, 열 때마다 어떤 필드를 채울지(context)만 바꾼다.
// ============================================================

let pathPickerContext = null; // { kind, hidden, onSelect }
let pathPickerPath = [];

function pathPickerItems() {
  const { kind } = pathPickerContext;
  const rawList = kind === "checkpoint" ? modelsCache[currentFam].checkpoints : modelsCache[currentFam].loras;
  return rawList.map((raw) => ({ raw, display: stripFilterPrefix(raw, kind, currentFam) }));
}

function renderPathPickerFileRow(item, fullPath) {
  const parts = item.display.split("\\");
  const rest = fullPath ? parts : parts.slice(pathPickerPath.length);
  const name = rest[rest.length - 1] || item.display;
  const dir = rest.slice(0, -1).join(" / ");
  const row = document.createElement("button");
  row.type = "button";
  row.className = "path-file-row";
  row.innerHTML = (dir ? `<span class="path-file-dir">${dir}</span>` : "") + `<span>${name}</span>`;
  row.addEventListener("click", () => {
    pathPickerContext.onSelect(item.raw);
    closePathPicker();
  });
  return row;
}

function renderPathPicker() {
  const crumbRow = document.getElementById("pathPickerCrumbRow");
  const fileListEl = document.getElementById("pathPickerFileList");
  const searchQuery = document.getElementById("pathPickerSearchInput").value.trim().toLowerCase();
  const items = pathPickerItems();

  crumbRow.innerHTML = "";
  fileListEl.innerHTML = "";

  if (searchQuery) {
    // 검색 중이면 카테고리를 무시하고 경로 전체에서 부분일치로 찾는다.
    items
      .filter((it) => it.display.toLowerCase().includes(searchQuery))
      .forEach((it) => fileListEl.appendChild(renderPathPickerFileRow(it, true)));
    return;
  }

  pathPickerPath.forEach((seg, i) => {
    const crumb = document.createElement("button");
    crumb.type = "button";
    crumb.className = "path-crumb selected";
    crumb.textContent = seg;
    crumb.addEventListener("click", () => {
      pathPickerPath = pathPickerPath.slice(0, i);
      renderPathPicker();
    });
    crumbRow.appendChild(crumb);
    const sep = document.createElement("span");
    sep.className = "path-crumb-sep";
    sep.textContent = "\\";
    crumbRow.appendChild(sep);
  });

  const children = new Set();
  items.forEach((it) => {
    const parts = it.display.split("\\");
    if (parts.length <= pathPickerPath.length + 1) return;
    if (pathPickerPath.every((seg, i) => parts[i] === seg)) children.add(parts[pathPickerPath.length]);
  });
  children.forEach((child) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "path-crumb";
    btn.textContent = child;
    btn.addEventListener("click", () => {
      pathPickerPath = [...pathPickerPath, child];
      renderPathPicker();
    });
    crumbRow.appendChild(btn);
  });

  items
    .filter((it) => {
      const parts = it.display.split("\\");
      return pathPickerPath.every((seg, i) => parts[i] === seg);
    })
    .forEach((it) => fileListEl.appendChild(renderPathPickerFileRow(it)));
}

function openPathPicker(kind, hidden, title, onSelect) {
  pathPickerPath = [];
  pathPickerContext = { kind, hidden, onSelect };
  document.getElementById("pathPickerTitle").textContent = title;
  document.getElementById("pathPickerSearchInput").value = "";
  renderPathPicker();

  const backdrop = document.getElementById("pathPickerBackdrop");
  const panel = document.getElementById("pathPickerPanel");
  backdrop.classList.add("open");
  panel.classList.add("open");
  document.documentElement.classList.add("scroll-locked");
  document.body.classList.add("scroll-locked");
  document.body.style.top = `-${window.scrollY}px`;
}

let pathPickerLockedScrollY = 0;

function closePathPicker() {
  document.getElementById("pathPickerBackdrop").classList.remove("open");
  document.getElementById("pathPickerPanel").classList.remove("open");
  document.documentElement.classList.remove("scroll-locked");
  document.body.classList.remove("scroll-locked");
  document.body.style.top = "";
  window.scrollTo(0, pathPickerLockedScrollY);
  pathPickerContext = null;
}

// ============================================================
// 모델 정보(CivitAI) - 체크포인트/LoRA의 ⓘ 버튼을 누르면 지금 선택된
// 파일의 CivitAI 정보(미리보기 이미지, 예시 프롬프트, 트리거 워드)를 보여준다.
// ============================================================

function openModelInfoOverlay() {
  document.getElementById("modelInfoBackdrop").classList.add("open");
  document.getElementById("modelInfoPanel").classList.add("open");
  document.documentElement.classList.add("scroll-locked");
  document.body.classList.add("scroll-locked");
  document.body.style.top = `-${window.scrollY}px`;
}

function closeModelInfoOverlay() {
  document.getElementById("modelInfoBackdrop").classList.remove("open");
  document.getElementById("modelInfoPanel").classList.remove("open");
  document.documentElement.classList.remove("scroll-locked");
  document.body.classList.remove("scroll-locked");
  document.body.style.top = "";
}

// ============================================================
// 모델 경로 설정 - ComfyUI가 그대로 쓰는 extra_model_paths.yaml 을 업로드하면
// 서버가 파싱해서 ANIMA/IL 의 실제 폴더 경로로 사용한다 (CivitAI 정보 조회용).
// ============================================================

async function refreshModelPathsStatus() {
  const status = document.getElementById("modelPathsStatus");
  const resetBtn = document.getElementById("modelPathsResetBtn");
  try {
    const res = await fetch("/api/model-paths");
    const data = await res.json();
    const anima = (data.basePaths && data.basePaths.anima) || "-";
    const il = (data.basePaths && data.basePaths.il) || "-";
    status.textContent = data.isCustom
      ? `업로드됨 · Anima: ${anima} · IL: ${il}`
      : `기본값 사용 중 · Anima: ${anima} · IL: ${il}`;
    resetBtn.style.display = data.isCustom ? "inline" : "none";
  } catch (e) {
    status.textContent = "경로 정보를 불러오지 못했습니다.";
  }
}

function initModelPathsSettings() {
  const uploadBtn = document.getElementById("modelPathsUploadBtn");
  const fileInput = document.getElementById("modelPathsFileInput");
  const resetBtn = document.getElementById("modelPathsResetBtn");
  const status = document.getElementById("modelPathsStatus");
  const toggleBtn = document.getElementById("modelPathsSettingsToggle");
  const section = document.getElementById("modelPathsSection");
  const animaInput = document.getElementById("modelPathsAnimaInput");
  const ilInput = document.getElementById("modelPathsIlInput");
  const baseApplyBtn = document.getElementById("modelPathsBaseApplyBtn");

  toggleBtn.addEventListener("click", () => {
    const isOpen = section.style.display === "block";
    section.style.display = isOpen ? "none" : "block";
  });

  baseApplyBtn.addEventListener("click", async () => {
    const anima = animaInput.value.trim();
    const il = ilInput.value.trim();
    if (!anima && !il) return;
    status.textContent = "적용 중...";
    try {
      const res = await fetch("/api/model-paths/set-base-paths", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anima, il }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        status.textContent = data.error || "적용에 실패했습니다.";
        return;
      }
      animaInput.value = "";
      ilInput.value = "";
      await refreshModelPathsStatus();
    } catch (e) {
      status.textContent = "적용 중 오류가 발생했습니다.";
    }
  });

  refreshModelPathsStatus();

  uploadBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    status.textContent = "업로드 중...";
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/model-paths/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok || data.error) {
        status.textContent = data.error || "업로드에 실패했습니다.";
        return;
      }
      await refreshModelPathsStatus();
    } catch (e) {
      status.textContent = "업로드 중 오류가 발생했습니다.";
    }
    fileInput.value = "";
  });

  resetBtn.addEventListener("click", async () => {
    try {
      await fetch("/api/model-paths/reset", { method: "POST" });
    } catch (e) {}
    await refreshModelPathsStatus();
  });
}

// ============================================================
// 해상도 프리셋 - 자주 쓰는 너비/높이 조합을 저장해두고 목록에서 바로 적용한다.
// 프리셋 이름 옆에 landscape/portrait 태그와, 최대공약수로 줄인 화면비율 태그가 붙는다.
// 화면비율은 눌러서 직접 입력할 수도 있는데, 입력한 비율에서 더 작은 숫자가 있는
// 쪽(가로/세로)을 지금 값 그대로 두고 반대쪽을 그 비율에 맞게 계산한다.
// ============================================================

function snapTo8(v) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return v;
  return Math.max(8, Math.round(n / 8) * 8);
}

function gcdNum(a, b) {
  return b === 0 ? a : gcdNum(b, a % b);
}

const KNOWN_ASPECT_RATIOS = [
  [1, 1], [5, 4], [4, 3], [3, 2], [16, 10], [16, 9], [21, 9], [2, 1],
  [4, 5], [3, 4], [2, 3], [10, 16], [9, 16], [9, 21], [1, 2],
];

function aspectRatioLabel(w, h) {
  if (!w || !h) return "-";
  const g = gcdNum(w, h);
  const rw = w / g;
  const rh = h / g;
  if (rw <= 99 && rh <= 99) return `${rw}:${rh}`;
  const target = w / h;
  let best = KNOWN_ASPECT_RATIOS[0];
  let bestDiff = Infinity;
  KNOWN_ASPECT_RATIOS.forEach(([a, b]) => {
    const diff = Math.abs(target - a / b);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = [a, b];
    }
  });
  return `약 ${best[0]}:${best[1]}`;
}

function orientationLabel(w, h) {
  if (w > h) return "landscape";
  if (h > w) return "portrait";
  return null;
}

function pillHtmlSmall(label) {
  return `<span style="display:inline-block; border:0.5px solid var(--border-strong); border-radius:999px; padding:1px 8px; font-size:10px; color:var(--text-secondary); margin-left:6px; vertical-align:middle;">${label}</span>`;
}

function initResSwap(wId, hId, btnId) {
  document.getElementById(btnId).addEventListener("click", () => {
    const wEl = document.getElementById(wId);
    const hEl = document.getElementById(hId);
    const tmp = wEl.value;
    wEl.value = hEl.value;
    hEl.value = tmp;
    wEl.dispatchEvent(new Event("input", { bubbles: true }));
    hEl.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function initSnap8(id) {
  const el = document.getElementById(id);
  el.addEventListener("change", () => {
    el.value = snapTo8(el.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function openResPresetPanel() {
  document.getElementById("resPresetBackdrop").classList.add("open");
  document.getElementById("resPresetPanel").classList.add("open");
  document.documentElement.classList.add("scroll-locked");
  document.body.classList.add("scroll-locked");
  document.body.style.top = `-${window.scrollY}px`;
}

function closeResPresetPanel() {
  document.getElementById("resPresetBackdrop").classList.remove("open");
  document.getElementById("resPresetPanel").classList.remove("open");
  document.documentElement.classList.remove("scroll-locked");
  document.body.classList.remove("scroll-locked");
  document.body.style.top = "";
}

async function loadAndRenderResPresets() {
  const list = document.getElementById("resPresetList");
  list.innerHTML = '<p style="font-size:11px; color:var(--text-muted); text-align:center; padding:12px 0;">불러오는 중...</p>';
  try {
    const res = await fetch("/api/resolution-presets");
    const presets = await res.json();
    renderResPresetList(presets);
  } catch (e) {
    list.innerHTML = '<p style="font-size:11px; color:var(--text-muted); text-align:center; padding:12px 0;">불러오지 못했습니다.</p>';
  }
}

function renderResPresetList(presets) {
  const list = document.getElementById("resPresetList");
  if (!presets.length) {
    list.innerHTML = '<p style="font-size:11px; color:var(--text-muted); text-align:center; padding:12px 0;">저장된 프리셋이 없습니다.</p>';
    return;
  }
  list.innerHTML = presets
    .map((p) => {
      const orient = orientationLabel(p.width, p.height);
      const ratio = aspectRatioLabel(p.width, p.height);
      return `
    <div class="res-preset-row" data-id="${p.id}" style="display:flex; align-items:center; gap:8px; border:0.5px solid var(--border); background:var(--surface-2); border-radius:var(--radius); padding:10px 12px;">
      <div style="flex:1; min-width:0;">
        <p style="font-size:13px; font-weight:500; margin:0;">${p.name}${orient ? pillHtmlSmall(orient) : ""}${pillHtmlSmall(ratio)}</p>
        <p style="font-size:11px; color:var(--text-muted); margin:0;">${p.width} × ${p.height}</p>
      </div>
      <button type="button" class="res-preset-apply" style="border:none; background:none; color:var(--text-accent); font-size:12px; flex-shrink:0;">적용</button>
      <button type="button" class="res-preset-delete" aria-label="삭제" style="border:none; background:none; color:var(--text-danger); font-size:14px; flex-shrink:0;"><i class="ti ti-trash" aria-hidden="true"></i></button>
    </div>`;
    })
    .join("");

  list.querySelectorAll(".res-preset-apply").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".res-preset-row");
      const p = presets.find((x) => x.id === row.dataset.id);
      if (!p) return;
      document.getElementById("widthInput").value = p.width;
      document.getElementById("heightInput").value = p.height;
      document.getElementById("widthInput").dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("heightInput").dispatchEvent(new Event("input", { bubbles: true }));
      closeResPresetPanel();
    });
  });
  list.querySelectorAll(".res-preset-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".res-preset-row");
      try {
        await fetch(`/api/resolution-presets/${row.dataset.id}`, { method: "DELETE" });
      } catch (e) {}
      loadAndRenderResPresets();
    });
  });
}

function initResPresetPanel() {
  const openBtn = document.getElementById("resPresetBtn");
  const closeBtn = document.getElementById("resPresetCloseBtn");
  const backdrop = document.getElementById("resPresetBackdrop");
  const nameInput = document.getElementById("resPresetNameInput");
  const wInput = document.getElementById("resPresetWInput");
  const hInput = document.getElementById("resPresetHInput");
  const liveRatio = document.getElementById("resPresetLiveRatio");
  const saveBtn = document.getElementById("resPresetSaveBtn");

  function updateLiveRatio() {
    liveRatio.textContent = aspectRatioLabel(parseInt(wInput.value, 10), parseInt(hInput.value, 10));
  }

  // 프리셋 패널에서 조정한 너비/높이를 실제 생성 해상도(메인 입력칸)에도 그대로 반영한다.
  function syncToMainResolution() {
    const mainW = document.getElementById("widthInput");
    const mainH = document.getElementById("heightInput");
    mainW.value = wInput.value;
    mainH.value = hInput.value;
    mainW.dispatchEvent(new Event("input", { bubbles: true }));
    mainH.dispatchEvent(new Event("input", { bubbles: true }));
  }

  openBtn.addEventListener("click", () => {
    wInput.value = document.getElementById("widthInput").value;
    hInput.value = document.getElementById("heightInput").value;
    nameInput.value = "";
    updateLiveRatio();
    openResPresetPanel();
    loadAndRenderResPresets();
  });
  closeBtn.addEventListener("click", closeResPresetPanel);
  backdrop.addEventListener("click", closeResPresetPanel);

  wInput.addEventListener("input", () => {
    updateLiveRatio();
    syncToMainResolution();
  });
  hInput.addEventListener("input", () => {
    updateLiveRatio();
    syncToMainResolution();
  });

  liveRatio.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = liveRatio.textContent;
    input.style.cssText = "width:52px; font-size:13px; text-align:center; margin:0; padding:2px 4px; height:28px;";
    liveRatio.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      const m = input.value.trim().match(/^(\d+)\s*:\s*(\d+)$/);
      if (m) {
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        if (a > 0 && b > 0) {
          const curW = parseInt(wInput.value, 10) || 0;
          const curH = parseInt(hInput.value, 10) || 0;
          // 비율에서 더 작은 숫자가 있는 자리를 그대로 고정하고, 반대쪽을 계산한다.
          if (a <= b) {
            hInput.value = snapTo8(Math.round(curW * (b / a)));
          } else {
            wInput.value = snapTo8(Math.round(curH * (a / b)));
          }
          syncToMainResolution();
        }
      }
      input.replaceWith(liveRatio);
      updateLiveRatio();
    }
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    });
  });

  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const width = snapTo8(wInput.value);
    const height = snapTo8(hInput.value);
    if (!name || !width || !height) return;
    try {
      const res = await fetch("/api/resolution-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, width, height }),
      });
      const data = await res.json();
      if (!res.ok || data.error) return;
      nameInput.value = "";
      loadAndRenderResPresets();
    } catch (e) {}
  });
}

// ============================================================
// 워크플로우 저장/불러오기 - 긍정 프롬프트 라벨 옆 버튼에서 접근한다.
// 저장은 지금 전체 설정(체크포인트/LoRA/해상도/프롬프트 등)을 서버에 저장하고,
// 불러오기는 저장된 목록/파일 업로드/이미지(PNG 메타데이터)에서 가져올 수 있다.
// 계열이 다르면 전환 여부를 묻고, 구조가 안 맞으면 토스트로 알리고 취소한다.
// ============================================================

let wfSelectedId = null;
let wfPendingParsed = null; // { family, appState } - 파일/이미지에서 파싱된 결과 대기

function famDisplayName(fam) {
  return fam === "anima" ? "Anima" : "Illustrious";
}

function openOverlaySimple(backdropId, panelId) {
  document.getElementById(backdropId).classList.add("open");
  document.getElementById(panelId).classList.add("open");
  document.documentElement.classList.add("scroll-locked");
  document.body.classList.add("scroll-locked");
  document.body.style.top = `-${window.scrollY}px`;
}

function closeOverlaySimple(backdropId, panelId) {
  document.getElementById(backdropId).classList.remove("open");
  document.getElementById(panelId).classList.remove("open");
  document.documentElement.classList.remove("scroll-locked");
  document.body.classList.remove("scroll-locked");
  document.body.style.top = "";
}

let wfToastTimer = null;
function showWfToast(message, isSuccess) {
  const toast = document.getElementById("wfErrorToast");
  toast.textContent = message;
  toast.style.background = isSuccess ? "var(--fill-success)" : "var(--fill-danger)";
  toast.style.color = isSuccess ? "var(--on-success)" : "var(--on-danger)";
  toast.style.display = "block";
  clearTimeout(wfToastTimer);
  wfToastTimer = setTimeout(() => {
    toast.style.display = "none";
  }, 2400);
}

function showWfErrorToast(message) {
  showWfToast(message, false);
}

function initWfSavePanel() {
  const openBtn = document.getElementById("workflowSaveBtn");
  const closeBtn = document.getElementById("wfSaveCloseBtn");
  const backdrop = document.getElementById("wfSaveBackdrop");
  const nameInput = document.getElementById("wfSaveNameInput");
  const confirmBtn = document.getElementById("wfSaveConfirmBtn");
  const cancelBtn = document.getElementById("wfSaveCancelBtn");

  openBtn.addEventListener("click", () => {
    nameInput.value = "";
    openOverlaySimple("wfSaveBackdrop", "wfSavePanel");
  });
  closeBtn.addEventListener("click", () => closeOverlaySimple("wfSaveBackdrop", "wfSavePanel"));
  backdrop.addEventListener("click", () => closeOverlaySimple("wfSaveBackdrop", "wfSavePanel"));
  cancelBtn.addEventListener("click", () => closeOverlaySimple("wfSaveBackdrop", "wfSavePanel"));

  confirmBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      showWfErrorToast("이름을 입력해주세요.");
      return;
    }
    Object.values(promptPillControllers).forEach((c) => c.syncToTextarea());
    const appState = collectState();
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, family: currentFam, appState }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        showWfErrorToast(data.error || "저장에 실패했습니다.");
        return;
      }
      closeOverlaySimple("wfSaveBackdrop", "wfSavePanel");
      showWfToast(`"${name}"으로 저장했습니다.`, true);
    } catch (e) {
      showWfErrorToast("저장 중 오류가 발생했습니다.");
    }
  });
}

let wfAllItems = [];

async function loadAndRenderWfList() {
  const listEl = document.getElementById("wfListItems");
  listEl.innerHTML = '<p style="font-size:12px; color:var(--text-muted); text-align:center; padding:14px 0;">불러오는 중...</p>';
  try {
    const res = await fetch(`/api/workflows?family=${encodeURIComponent(currentFam)}`);
    wfAllItems = await res.json();
    document.getElementById("wfSearchInput").value = "";
    renderWfItems(wfAllItems);
  } catch (e) {
    listEl.innerHTML = '<p style="font-size:12px; color:var(--text-muted); text-align:center; padding:14px 0;">불러오지 못했습니다.</p>';
  }
}

function renderWfItems(items) {
  const listEl = document.getElementById("wfListItems");
  if (!items.length) {
    listEl.innerHTML = `<p style="font-size:12px; color:var(--text-muted); text-align:center; padding:14px 0;">${famDisplayName(currentFam)} 계열로 저장된 워크플로우가 없습니다.</p>`;
    return;
  }
  {
    listEl.innerHTML = items
      .map(
        (w) => `
      <div class="wf-list-item" data-id="${w.id}" style="display:flex; align-items:center; gap:8px; border:0.5px solid var(--border); background:var(--surface-2); border-radius:var(--radius); padding:9px 10px; margin-bottom:6px; cursor:pointer;">
        <div style="flex:1; min-width:0;">
          <p style="font-size:13px; font-weight:500; margin:0;">${w.name}</p>
          <p style="font-size:11px; color:var(--text-muted); margin:0;">${w.width || "?"} × ${w.height || "?"}</p>
        </div>
        <button type="button" class="wf-list-delete" aria-label="삭제" style="border:none; background:none; color:var(--text-danger); font-size:15px; flex-shrink:0; padding:4px;">
          <i class="ti ti-trash" aria-hidden="true"></i>
        </button>
        <button type="button" class="wf-list-detail" aria-label="자세히 보기" style="border:none; background:none; color:var(--text-muted); font-size:16px; flex-shrink:0; padding:4px;">
          <i class="ti ti-chevron-right" aria-hidden="true"></i>
        </button>
      </div>`
      )
      .join("");
    listEl.querySelectorAll(".wf-list-item").forEach((el) => {
      el.addEventListener("click", () => {
        listEl.querySelectorAll(".wf-list-item").forEach((x) => (x.style.borderColor = "var(--border)"));
        el.style.borderColor = "var(--border-accent)";
        wfSelectedId = el.dataset.id;
      });
    });
    listEl.querySelectorAll(".wf-list-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const item = btn.closest(".wf-list-item");
        const w = items.find((x) => x.id === item.dataset.id);
        requestWfDelete(item.dataset.id, w ? w.name : "");
      });
    });
    listEl.querySelectorAll(".wf-list-detail").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const item = btn.closest(".wf-list-item");
        const w = items.find((x) => x.id === item.dataset.id);
        await showWfDetail(item.dataset.id, w ? w.name : "");
      });
    });
  }
}

let wfPendingDeleteId = null;

function requestWfDelete(id, name) {
  wfPendingDeleteId = id;
  document.getElementById("wfDeleteConfirmText").textContent = name
    ? `"${name}"을(를) 정말 삭제하시겠습니까? 서버에서 완전히 삭제되며 되돌릴 수 없습니다.`
    : "정말 삭제하시겠습니까? 서버에서 완전히 삭제되며 되돌릴 수 없습니다.";
  document.getElementById("wfDeleteConfirmBackdrop").style.display = "flex";
}

function requestWfDeleteAll() {
  wfPendingDeleteId = "__ALL__";
  document.getElementById("wfDeleteConfirmText").textContent =
    "서버에 저장된 워크플로우를 전부 삭제하시겠습니까? 되돌릴 수 없습니다.";
  document.getElementById("wfDeleteConfirmBackdrop").style.display = "flex";
}

function initWfDeleteConfirm() {
  const backdrop = document.getElementById("wfDeleteConfirmBackdrop");
  document.getElementById("wfDeleteCancelBtn").addEventListener("click", () => {
    wfPendingDeleteId = null;
    backdrop.style.display = "none";
  });
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      wfPendingDeleteId = null;
      backdrop.style.display = "none";
    }
  });
  document.getElementById("wfDeleteConfirmBtn").addEventListener("click", async () => {
    const id = wfPendingDeleteId;
    if (!id) return;
    backdrop.style.display = "none";
    try {
      if (id === "__ALL__") {
        await fetch("/api/workflows", { method: "DELETE" });
        wfSelectedId = null;
      } else {
        await fetch(`/api/workflows/${id}`, { method: "DELETE" });
        if (wfSelectedId === id) wfSelectedId = null;
      }
    } catch (err) {}
    wfPendingDeleteId = null;
    loadAndRenderWfList();
    showWfToast(id === "__ALL__" ? "전체 삭제했습니다." : "삭제했습니다.", true);
  });
}

async function showWfDetail(id, name) {
  const backdrop = document.getElementById("wfDetailBackdrop");
  document.getElementById("wfDetailTitle").textContent = name;
  document.getElementById("wfDetailPositive").textContent = "불러오는 중...";
  document.getElementById("wfDetailNegative").textContent = "";
  backdrop.style.display = "flex";
  try {
    const res = await fetch(`/api/workflows/${id}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      document.getElementById("wfDetailPositive").textContent = "불러오지 못했습니다.";
      return;
    }
    const state = data.app_state || {};
    document.getElementById("wfDetailPositive").textContent = state.positivePrompt || "(비어있음)";
    document.getElementById("wfDetailNegative").textContent = state.negativePrompt || "(비어있음)";
  } catch (e) {
    document.getElementById("wfDetailPositive").textContent = "불러오지 못했습니다.";
  }
}

function switchFamilyProgrammatically(fam) {
  currentFam = fam;
  document.querySelectorAll(".fam-btn").forEach((b) => b.classList.toggle("active", b.getAttribute("data-fam") === fam));
  refreshAllFilterDisplays();
}

function applyLoadedAppState(appState, scope) {
  if (scope === "prompt") {
    const posEl = document.getElementById("positivePrompt");
    const negEl = document.getElementById("negativePrompt");
    posEl.value = appState.positivePrompt || "";
    negEl.value = appState.negativePrompt || "";
    posEl.dispatchEvent(new Event("input", { bubbles: true }));
    negEl.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    applyState(appState);
  }
  Object.values(promptPillControllers).forEach((c) => c.forceSync());
  saveNow();
}

function resetWfScopeUI() {
  document.querySelectorAll('input[name="wfLoadScope"]').forEach((r) => {
    r.disabled = false;
  });
  document.querySelector('input[name="wfLoadScope"][value="all"]').checked = true;
  document.getElementById("wfScopeSection").style.display = "block";
  document.getElementById("wfFamMismatchNotice").style.display = "none";
}

function handleFamilyCheck(family) {
  if (family === currentFam) {
    resetWfScopeUI();
    return;
  }
  document.getElementById("wfScopeSection").style.display = "none";
  document.getElementById("wfFamMismatchNotice").style.display = "none";
  const sourceLabel = "이 워크플로우는";
  document.getElementById("wfFamMismatchText").textContent = `${sourceLabel} ${famDisplayName(family)}에서 생성된 것입니다. 해당 모델로 전환할까요?`;
  document.getElementById("wfFamMismatchNotice").style.display = "block";
}

async function handleWfFileSelect(file, nameTextId, nameValueId) {
  if (nameTextId && nameValueId) {
    document.getElementById(nameValueId).textContent = file.name;
    document.getElementById(nameTextId).style.display = "flex";
  }
  const confirmBtn = document.getElementById("wfLoadConfirmBtn");
  wfPendingParsed = null;
  confirmBtn.disabled = true;
  const originalLabel = confirmBtn.textContent;
  confirmBtn.textContent = "분석 중...";
  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await fetch("/api/workflows/parse", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok || data.error) {
      showWfErrorToast("워크플로우 불일치: 이 앱에서 사용하는 구조가 아닙니다");
      wfPendingParsed = null;
      return;
    }
    wfPendingParsed = data;
    handleFamilyCheck(data.family);
  } catch (e) {
    showWfErrorToast("불러오는 중 오류가 발생했습니다.");
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = originalLabel;
  }
}

function initWfLoadPanel() {
  document.getElementById("wfDeleteAllBtn").addEventListener("click", requestWfDeleteAll);
  document.getElementById("wfSearchInput").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    renderWfItems(q ? wfAllItems.filter((w) => w.name.toLowerCase().includes(q)) : wfAllItems);
  });

  document.getElementById("wfDetailCloseBtn").addEventListener("click", () => {
    document.getElementById("wfDetailBackdrop").style.display = "none";
  });
  document.getElementById("wfDetailBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "wfDetailBackdrop") e.currentTarget.style.display = "none";
  });


  const openBtn = document.getElementById("workflowLoadBtn");
  const closeBtn = document.getElementById("wfLoadCloseBtn");
  const backdrop = document.getElementById("wfLoadBackdrop");
  const cancelBtn = document.getElementById("wfLoadCancelBtn");
  const confirmBtn = document.getElementById("wfLoadConfirmBtn");
  let activeTab = "list";

  function reset() {
    wfSelectedId = null;
    wfPendingParsed = null;
    activeTab = "list";
    const confirmBtn = document.getElementById("wfLoadConfirmBtn");
    confirmBtn.disabled = false;
    confirmBtn.textContent = "불러오기";
    document.getElementById("wfFileNameText").style.display = "none";
    document.getElementById("wfImageNameText").style.display = "none";
    document.querySelectorAll(".wfLoadTab").forEach((b) => {
      const isList = b.dataset.tab === "list";
      b.classList.toggle("active", isList);
      b.style.background = isList ? "var(--fill-primary)" : "transparent";
      b.style.color = isList ? "var(--on-primary)" : "var(--text-secondary)";
    });
    document.querySelectorAll(".wfLoadTabPanel").forEach((p) => (p.style.display = "none"));
    document.getElementById("wfTabList").style.display = "block";
    resetWfScopeUI();
  }

  openBtn.addEventListener("click", () => {
    reset();
    openOverlaySimple("wfLoadBackdrop", "wfLoadPanel");
    loadAndRenderWfList();
  });
  closeBtn.addEventListener("click", () => closeOverlaySimple("wfLoadBackdrop", "wfLoadPanel"));
  backdrop.addEventListener("click", () => closeOverlaySimple("wfLoadBackdrop", "wfLoadPanel"));
  cancelBtn.addEventListener("click", () => closeOverlaySimple("wfLoadBackdrop", "wfLoadPanel"));

  document.querySelectorAll(".wfLoadTab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll(".wfLoadTab").forEach((b) => {
        b.style.background = "transparent";
        b.style.color = "var(--text-secondary)";
      });
      btn.style.background = "var(--fill-primary)";
      btn.style.color = "var(--on-primary)";
      document.querySelectorAll(".wfLoadTabPanel").forEach((p) => (p.style.display = "none"));
      const panelId = `wfTab${activeTab.charAt(0).toUpperCase()}${activeTab.slice(1)}`;
      document.getElementById(panelId).style.display = "block";
      wfPendingParsed = null;
      resetWfScopeUI();
    });
  });

  document.getElementById("wfFilePickBtn").addEventListener("click", () => document.getElementById("wfFileInput").click());
  document.getElementById("wfFileInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleWfFileSelect(file, "wfFileNameText", "wfFileNameValue");
    e.target.value = "";
  });

  document.getElementById("wfImagePickBtn").addEventListener("click", () => document.getElementById("wfImageInput").click());
  document.getElementById("wfImageInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleWfFileSelect(file, "wfImageNameText", "wfImageNameValue");
    e.target.value = "";
  });

  document.getElementById("wfFamSwitchYesBtn").addEventListener("click", () => {
    if (wfPendingParsed) switchFamilyProgrammatically(wfPendingParsed.family);
    resetWfScopeUI();
  });
  document.getElementById("wfFamSwitchNoBtn").addEventListener("click", () => {
    document.getElementById("wfFamMismatchNotice").style.display = "none";
    document.getElementById("wfScopeSection").style.display = "block";
    document.querySelector('input[name="wfLoadScope"][value="prompt"]').checked = true;
    document.querySelectorAll('input[name="wfLoadScope"]').forEach((r) => {
      r.disabled = r.value === "all";
    });
  });

  confirmBtn.addEventListener("click", async () => {
    const scope = document.querySelector('input[name="wfLoadScope"]:checked').value;
    if (activeTab === "list") {
      if (!wfSelectedId) {
        showWfErrorToast("먼저 목록에서 항목을 선택해주세요.");
        return;
      }
      try {
        const res = await fetch(`/api/workflows/${wfSelectedId}`);
        const data = await res.json();
        if (!res.ok || data.error) {
          showWfErrorToast(data.error || "불러오지 못했습니다.");
          return;
        }
        applyLoadedAppState(data.app_state, scope);
        closeOverlaySimple("wfLoadBackdrop", "wfLoadPanel");
        showWfToast("불러왔습니다.", true);
      } catch (e) {
        showWfErrorToast("불러오는 중 오류가 발생했습니다.");
      }
    } else {
      if (!wfPendingParsed) {
        showWfErrorToast("먼저 파일이나 이미지를 선택해주세요.");
        return;
      }
      applyLoadedAppState(wfPendingParsed.appState, scope);
      closeOverlaySimple("wfLoadBackdrop", "wfLoadPanel");
      showWfToast("불러왔습니다.", true);
    }
  });
}

// ============================================================
// 영역별 프롬프트 (Regional Prompting)
// - 캔버스 위에 사각형을 그리면 그 영역에만 적용되는 긍정/부정 프롬프트를 만들 수 있다.
// - 각 영역의 프롬프트는 기존 프롬프트 레이어(텍스트/태그 모드, 자동완성)를 그대로
//   재사용한다: initPromptPillEditor/initInlinePromptAutocomplete에 고유 prefix만
//   부여해서 등록하면, promptPillControllers 기반의 모든 강제 동기화(forceSync) 로직이
//   자동으로 영역 프롬프트에도 적용된다 (계열 전환/불러오기/설정 재사용 등에서 이미
//   고쳐둔 배관을 그대로 재사용 - 새로운 버그를 만들지 않기 위함).
// ============================================================

const REGION_COLORS = ["#378ADD", "#D85A30", "#639922", "#D4537E", "#7F77DD", "#1D9E75"];
const REGION_MIN_SIZE = 64;
let regions = [];
let regionSeq = 0;

function snapRegion8(v) {
  return Math.round(v / 8) * 8;
}

function currentCanvasSize() {
  return {
    w: parseInt(document.getElementById("widthInput").value, 10) || 960,
    h: parseInt(document.getElementById("heightInput").value, 10) || 1280,
  };
}

function clampRegionsToCanvas() {
  const { w: canvasW, h: canvasH } = currentCanvasSize();
  let changed = false;
  regions.forEach((r) => {
    const newW = Math.max(REGION_MIN_SIZE, Math.min(r.w, snapRegion8(canvasW)));
    const newH = Math.max(REGION_MIN_SIZE, Math.min(r.h, snapRegion8(canvasH)));
    const newX = Math.max(0, Math.min(r.x, canvasW - newW));
    const newY = Math.max(0, Math.min(r.y, canvasH - newH));
    if (newW !== r.w || newH !== r.h || newX !== r.x || newY !== r.y) {
      r.w = newW;
      r.h = newH;
      r.x = snapRegion8(newX);
      r.y = snapRegion8(newY);
      changed = true;
      updateRegionInfoText(r);
    }
  });
  return changed;
}

function renderRegionCanvas() {
  const canvas = document.getElementById("regionCanvas");
  const { w: canvasW, h: canvasH } = currentCanvasSize();
  canvas.style.aspectRatio = `${canvasW} / ${canvasH}`;
  canvas.innerHTML = "";
  regions.forEach((r) => {
    const el = document.createElement("div");
    el.className = "region-overlay";
    el.style.left = `${(r.x / canvasW) * 100}%`;
    el.style.top = `${(r.y / canvasH) * 100}%`;
    el.style.width = `${(r.w / canvasW) * 100}%`;
    el.style.height = `${(r.h / canvasH) * 100}%`;
    el.style.borderColor = r.color;
    el.style.background = `${r.color}33`;
    const handleDirs = {
      nw: "top:0; left:0; cursor:nwse-resize;",
      ne: "top:0; left:100%; cursor:nesw-resize;",
      sw: "top:100%; left:0; cursor:nesw-resize;",
      se: "top:100%; left:100%; cursor:nwse-resize;",
      n: "top:0; left:50%; cursor:ns-resize;",
      s: "top:100%; left:50%; cursor:ns-resize;",
      e: "top:50%; left:100%; cursor:ew-resize;",
      w: "top:50%; left:0; cursor:ew-resize;",
    };
    Object.keys(handleDirs).forEach((dir) => {
      const handle = document.createElement("div");
      handle.className = "region-handle";
      handle.style.cssText = handleDirs[dir];
      handle.style.background = r.color;
      handle.addEventListener("pointerdown", (e) => startRegionResize(e, r, dir));
      el.appendChild(handle);
    });
    el.addEventListener("pointerdown", (e) => {
      if (e.target === el) startRegionMove(e, r);
    });
    canvas.appendChild(el);
  });
}

function updateRegionInfoText(region) {
  const el = document.querySelector(`.region-info-text[data-region-id="${region.id}"]`);
  if (el) el.textContent = `${region.w} × ${region.h} @ (${region.x}, ${region.y})`;
}

function startRegionMove(e, r) {
  e.preventDefault();
  const canvas = document.getElementById("regionCanvas");
  const { w: canvasW, h: canvasH } = currentCanvasSize();
  const rect = canvas.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const ox = r.x;
  const oy = r.y;
  function move(ev) {
    const dx = ((ev.clientX - startX) / rect.width) * canvasW;
    const dy = ((ev.clientY - startY) / rect.height) * canvasH;
    r.x = Math.max(0, Math.min(canvasW - r.w, snapRegion8(ox + dx)));
    r.y = Math.max(0, Math.min(canvasH - r.h, snapRegion8(oy + dy)));
    renderRegionCanvas();
    updateRegionInfoText(r);
  }
  function up() {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    saveNow();
  }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

function startRegionResize(e, r, dir) {
  e.preventDefault();
  e.stopPropagation();
  const canvas = document.getElementById("regionCanvas");
  const { w: canvasW, h: canvasH } = currentCanvasSize();
  const rect = canvas.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const orig = { x: r.x, y: r.y, w: r.w, h: r.h };
  function move(ev) {
    const dx = ((ev.clientX - startX) / rect.width) * canvasW;
    const dy = ((ev.clientY - startY) / rect.height) * canvasH;
    if (dir.includes("e")) r.w = Math.max(REGION_MIN_SIZE, snapRegion8(orig.w + dx));
    if (dir.includes("s")) r.h = Math.max(REGION_MIN_SIZE, snapRegion8(orig.h + dy));
    if (dir.includes("w")) {
      r.w = Math.max(REGION_MIN_SIZE, snapRegion8(orig.w - dx));
      r.x = snapRegion8(orig.x + orig.w - r.w);
    }
    if (dir.includes("n")) {
      r.h = Math.max(REGION_MIN_SIZE, snapRegion8(orig.h - dy));
      r.y = snapRegion8(orig.y + orig.h - r.h);
    }
    r.x = Math.max(0, r.x);
    r.y = Math.max(0, r.y);
    r.w = Math.min(r.w, canvasW - r.x);
    r.h = Math.min(r.h, canvasH - r.y);
    renderRegionCanvas();
    updateRegionInfoText(r);
  }
  function up() {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    saveNow();
  }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

function initRegionCanvasDraw() {
  const canvas = document.getElementById("regionCanvas");
  canvas.style.minHeight = "80px";
  canvas.addEventListener("pointerdown", (e) => {
    if (e.target !== canvas) return;
    const { w: canvasW, h: canvasH } = currentCanvasSize();
    const rect = canvas.getBoundingClientRect();
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const sx = ((e.clientX - rect.left) / rect.width) * canvasW;
    const sy = ((e.clientY - rect.top) / rect.height) * canvasH;
    const region = addRegion(snapRegion8(sx), snapRegion8(sy), REGION_MIN_SIZE, REGION_MIN_SIZE);
    let dragged = false;

    function move(ev) {
      const dist = Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY);
      if (dist > 6) dragged = true;
      const cx = ((ev.clientX - rect.left) / rect.width) * canvasW;
      const cy = ((ev.clientY - rect.top) / rect.height) * canvasH;
      region.w = Math.max(REGION_MIN_SIZE, Math.min(canvasW - region.x, snapRegion8(cx - region.x)));
      region.h = Math.max(REGION_MIN_SIZE, Math.min(canvasH - region.y, snapRegion8(cy - region.y)));
      renderRegionCanvas();
      updateRegionInfoText(region);
    }
    function up() {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      if (!dragged) {
        region.w = REGION_MIN_SIZE;
        region.h = REGION_MIN_SIZE;
        region.x = Math.max(0, Math.min(canvasW - REGION_MIN_SIZE, snapRegion8(sx - REGION_MIN_SIZE / 2)));
        region.y = Math.max(0, Math.min(canvasH - REGION_MIN_SIZE, snapRegion8(sy - REGION_MIN_SIZE / 2)));
        renderRegionCanvas();
        updateRegionInfoText(region);
      }
      saveNow();
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
}

function regionCardTemplate(region) {
  const pfx = `region${region.id}`;
  return `
    <div class="region-card-header" data-region-id="${region.id}">
      <span class="region-dot" style="background:${region.color};"></span>
      <span style="flex:1; font-size:12px;">영역</span>
      <span class="region-info-text" data-region-id="${region.id}" style="font-size:11px; color:var(--text-muted);">${region.w} × ${region.h} @ (${region.x}, ${region.y})</span>
      <button type="button" class="region-delete-btn" aria-label="영역 삭제" style="border:none; background:none; color:var(--text-danger); font-size:15px; flex-shrink:0; padding:2px;">
        <i class="ti ti-trash" aria-hidden="true"></i>
      </button>
      <i class="ti ti-chevron-up region-chevron" aria-hidden="true" style="color:var(--text-muted); font-size:14px;"></i>
    </div>
    <div class="region-card-body">
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:11px; color:var(--text-muted); min-width:32px; flex-shrink:0;">강도</span>
        <input type="range" id="${pfx}Strength" min="0" max="2" step="0.05" value="1" style="flex:1;">
        <span id="${pfx}StrengthOut" style="font-size:11px; min-width:32px; text-align:right; flex-shrink:0;">1.00</span>
      </div>
      <div>
        <div class="label-row" style="margin-bottom:4px;">
          <label class="label" style="margin:0;">긍정 프롬프트</label>
          <div style="display:flex; gap:10px;">
            <button type="button" class="shared-prompt-mode-btn region-mode-btn" style="border:none; background:none; color:var(--text-secondary); font-size:12px; padding:0;">모드 전환</button>
            <button type="button" class="region-import-btn" style="border:none; background:none; color:var(--text-accent); font-size:12px; padding:0;">가져오기</button>
          </div>
        </div>
        <div class="prompt-wrap">
          <textarea id="${pfx}PositivePrompt" rows="2" placeholder="이 영역만의 긍정 프롬프트"></textarea>
          <div id="${pfx}PositivePromptAc" class="inline-ac-dropdown"></div>
        </div>
        <div id="${pfx}PositivePillBox" class="prompt-pill-box" style="display:none;"></div>
      </div>
      <div>
        <div class="label-row" style="margin-bottom:4px;">
          <label class="label" style="margin:0;">부정 프롬프트</label>
          <label style="display:flex; align-items:center; gap:4px; font-size:11px; color:var(--text-secondary); cursor:pointer;">
            <input type="checkbox" class="region-neg-toggle" checked>메인과 동일하게 사용
          </label>
        </div>
        <p class="region-neg-static" style="font-size:12px; color:var(--text-muted); background:var(--surface-1); border-radius:var(--radius); padding:8px 10px; margin:0;"></p>
        <div class="region-neg-editable" style="display:none;">
          <div class="prompt-wrap">
            <textarea id="${pfx}NegativePrompt" rows="2" placeholder="이 영역만의 부정 프롬프트"></textarea>
            <div id="${pfx}NegativePromptAc" class="inline-ac-dropdown"></div>
          </div>
          <div id="${pfx}NegativePillBox" class="prompt-pill-box" style="display:none;"></div>
        </div>
      </div>
    </div>`;
}

function addRegion(x, y, w, h, opts) {
  regionSeq += 1;
  const region = {
    id: regionSeq,
    x, y, w, h,
    color: REGION_COLORS[(regionSeq - 1) % REGION_COLORS.length],
    useMainNeg: true,
    strength: 1,
  };
  if (opts) Object.assign(region, opts);
  regions.push(region);
  buildRegionCard(region);
  renderRegionCanvas();
  return region;
}

function buildRegionCard(region) {
  const list = document.getElementById("regionList");
  const wrap = document.createElement("div");
  wrap.className = "region-card";
  wrap.dataset.regionId = region.id;
  wrap.innerHTML = regionCardTemplate(region);
  list.appendChild(wrap);

  const pfx = `region${region.id}`;
  initPromptPillEditor(`${pfx}Positive`, false);
  initInlinePromptAutocomplete(`${pfx}PositivePrompt`, `${pfx}PositivePromptAc`);
  initPromptPillEditor(`${pfx}Negative`, true);
  initInlinePromptAutocomplete(`${pfx}NegativePrompt`, `${pfx}NegativePromptAc`);
  // 새 영역이 이미 태그 모드로 보이는 중이라면, 지금 공유 모드에 맞춰 즉시 화면을 맞춘다.
  promptPillControllers[`${pfx}Positive`].applyMode();
  promptPillControllers[`${pfx}Negative`].applyMode();

  const header = wrap.querySelector(".region-card-header");
  const body = wrap.querySelector(".region-card-body");
  const chevron = wrap.querySelector(".region-chevron");
  header.addEventListener("click", (e) => {
    if (e.target.closest(".region-delete-btn")) return;
    const isOpen = body.style.display !== "none";
    body.style.display = isOpen ? "none" : "flex";
    chevron.className = `ti ${isOpen ? "ti-chevron-down" : "ti-chevron-up"} region-chevron`;
  });

  wrap.querySelector(".region-delete-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteRegion(region.id);
  });

  wrap.querySelector(".region-mode-btn").addEventListener("click", toggleSharedPromptMode);

  const strengthRange = wrap.querySelector(`#${pfx}Strength`);
  const strengthOut = wrap.querySelector(`#${pfx}StrengthOut`);
  strengthRange.value = region.strength;
  strengthOut.textContent = parseFloat(region.strength).toFixed(2);
  strengthRange.addEventListener("input", () => {
    region.strength = parseFloat(strengthRange.value);
    strengthOut.textContent = region.strength.toFixed(2);
    saveNow();
  });
  makeEditableSliderOutput(strengthRange, strengthOut, 2);
  // 이미 태그 모드로 전환돼 있는 상태에서 영역을 새로 만들면, 그 영역의 모드 버튼도
  // 처음부터 현재 공유 모드에 맞는 색으로 보여야 한다 (기본값인 회색으로 남지 않도록).
  wrap.querySelector(".region-mode-btn").style.color =
    sharedPromptMode === "pill" ? "var(--fill-brand)" : "var(--text-secondary)";

  wrap.querySelector(".region-import-btn").addEventListener("click", () => {
    const mainPositive = document.getElementById("positivePrompt").value;
    const posEl = document.getElementById(`${pfx}PositivePrompt`);
    posEl.value = mainPositive;
    posEl.dispatchEvent(new Event("input", { bubbles: true }));
    promptPillControllers[`${pfx}Positive`].forceSync();
    saveNow();
  });

  const negStatic = wrap.querySelector(".region-neg-static");
  const negEditable = wrap.querySelector(".region-neg-editable");
  function refreshNegStatic() {
    negStatic.textContent = document.getElementById("negativePrompt").value || "(비어있음)";
  }
  refreshNegStatic();
  wrap.querySelector(".region-neg-toggle").addEventListener("change", (e) => {
    region.useMainNeg = e.target.checked;
    negStatic.style.display = region.useMainNeg ? "block" : "none";
    negEditable.style.display = region.useMainNeg ? "none" : "block";
    if (region.useMainNeg) refreshNegStatic();
    saveNow();
  });
}

function deleteRegion(id) {
  regions = regions.filter((r) => r.id !== id);
  delete promptPillControllers[`region${id}Positive`];
  delete promptPillControllers[`region${id}Negative`];
  const card = document.querySelector(`.region-card[data-region-id="${id}"]`);
  if (card) card.remove();
  renderRegionCanvas();
  saveNow();
}

function clearAllRegions() {
  regions.forEach((r) => {
    delete promptPillControllers[`region${r.id}Positive`];
    delete promptPillControllers[`region${r.id}Negative`];
  });
  regions = [];
  document.getElementById("regionList").innerHTML = "";
  renderRegionCanvas();
}

function collectRegionsState() {
  return regions.map((r) => ({
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    color: r.color,
    useMainNeg: r.useMainNeg,
    strength: r.strength,
    positivePrompt: document.getElementById(`region${r.id}PositivePrompt`).value,
    negativePrompt: r.useMainNeg ? "" : document.getElementById(`region${r.id}NegativePrompt`).value,
  }));
}

function applyRegionsState(regionStates) {
  clearAllRegions();
  (regionStates || []).forEach((rs, i) => {
    const region = addRegion(rs.x || 0, rs.y || 0, rs.w || REGION_MIN_SIZE, rs.h || REGION_MIN_SIZE, {
      color: rs.color || REGION_COLORS[i % REGION_COLORS.length],
      useMainNeg: rs.useMainNeg !== false,
      strength: rs.strength != null ? rs.strength : 1,
    });
    const posEl = document.getElementById(`region${region.id}PositivePrompt`);
    posEl.value = rs.positivePrompt || "";
    posEl.dispatchEvent(new Event("input", { bubbles: true }));
    promptPillControllers[`region${region.id}Positive`].forceSync();

    const card = document.querySelector(`.region-card[data-region-id="${region.id}"]`);
    const toggle = card.querySelector(".region-neg-toggle");
    toggle.checked = region.useMainNeg;
    const negStatic = card.querySelector(".region-neg-static");
    const negEditable = card.querySelector(".region-neg-editable");
    negStatic.style.display = region.useMainNeg ? "block" : "none";
    negEditable.style.display = region.useMainNeg ? "none" : "block";
    if (!region.useMainNeg) {
      const negEl = document.getElementById(`region${region.id}NegativePrompt`);
      negEl.value = rs.negativePrompt || "";
      negEl.dispatchEvent(new Event("input", { bubbles: true }));
      promptPillControllers[`region${region.id}Negative`].forceSync();
    } else {
      negStatic.textContent = document.getElementById("negativePrompt").value || "(비어있음)";
    }
    updateRegionInfoText(region);
  });
  renderRegionCanvas();
  if (regions.length > 0) {
    setRegionSectionCollapsed(false);
  }
}

let regionSectionCollapsed = true;

function setRegionSectionCollapsed(collapsed) {
  regionSectionCollapsed = collapsed;
  const regionBody = document.getElementById("regionSectionBody");
  const regionChevron = document.getElementById("regionSectionChevron");
  regionBody.style.display = collapsed ? "none" : "block";
  regionChevron.style.transform = collapsed ? "rotate(-90deg)" : "rotate(0deg)";
  if (!collapsed) {
    // 접혀있는(display:none) 동안에는 textarea의 자동 높이 계산이 0에 가깝게 잘못
    // 이뤄지므로, 실제로 보이게 되는 지금 다시 계산해서 잘려 보이지 않게 한다.
    document.querySelectorAll("#regionList textarea").forEach((el) => autoGrowTextarea(el));
  }
}

function initRegionSection() {
  initRegionCanvasDraw();

  const regionLabel = document.getElementById("regionSectionLabel");
  regionLabel.addEventListener("click", () => setRegionSectionCollapsed(!regionSectionCollapsed));

  document.getElementById("addRegionBtn").addEventListener("click", () => {
    const { w: canvasW, h: canvasH } = currentCanvasSize();
    addRegion(
      Math.max(0, Math.floor((canvasW - REGION_MIN_SIZE) / 2 / 8) * 8),
      Math.max(0, Math.floor((canvasH - REGION_MIN_SIZE) / 2 / 8) * 8),
      REGION_MIN_SIZE,
      REGION_MIN_SIZE
    );
    setRegionSectionCollapsed(false);
    saveNow();
  });
  renderRegionCanvas();
}


function initModelInfoOverlay() {
  document.getElementById("modelInfoBackdrop").addEventListener("click", closeModelInfoOverlay);
  document.getElementById("modelInfoCloseBtn").addEventListener("click", closeModelInfoOverlay);
}

async function showModelInfo(kind, rawName) {
  const title = document.getElementById("modelInfoTitle");
  const body = document.getElementById("modelInfoBody");
  title.textContent = kind === "checkpoint" ? "체크포인트 정보" : "LoRA 정보";
  body.innerHTML = '<div class="model-info-loading">CivitAI에서 정보를 불러오는 중...</div>';
  openModelInfoOverlay();

  try {
    const res = await fetch(
      `/api/model-info?family=${encodeURIComponent(currentFam)}&kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(rawName)}`
    );
    const data = await res.json();
    if (!res.ok || data.error) {
      body.innerHTML = `<div class="model-info-error">${data.error || "정보를 가져오지 못했습니다."}</div>`;
      return;
    }

    let html = "";
    if (data.images && data.images.length) {
      html += '<div class="model-info-images">';
      html += data.images.map((img) => `<img src="${img.url}" alt="예시 이미지" loading="lazy">`).join("");
      html += "</div>";
    }
    html += `<p class="model-info-field"><b>이름:</b> ${data.name || "-"}</p>`;
    html += `<p class="model-info-field"><b>버전:</b> ${data.versionName || "-"}</p>`;
    html += `<p class="model-info-field"><b>베이스 모델:</b> ${data.baseModel || "Unknown"}</p>`;

    if (data.trainedWords && data.trainedWords.length) {
      html += '<p class="model-info-section-title">트리거 워드</p>';
      html += `<div class="model-info-trained-words">${data.trainedWords.join(", ")}</div>`;
    }

    const examplePrompts = (data.images || []).map((img) => img.prompt).filter((p) => p);
    if (examplePrompts.length) {
      html += '<p class="model-info-section-title">예시 프롬프트</p>';
      html += examplePrompts
        .slice(0, 4)
        .map((p) => `<div class="model-info-prompt-box">${p}</div>`)
        .join("");
    }

    if (data.civitaiUrl) {
      html += `<a class="model-info-link" href="${data.civitaiUrl}" target="_blank" rel="noopener">CivitAI에서 보기 →</a>`;
    }

    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = '<div class="model-info-error">조회 중 오류가 발생했습니다.</div>';
  }
}

function initCkptInfoButton() {
  document.getElementById("ckptInfoBtn").addEventListener("click", () => {
    const value = document.getElementById("ckptSelect").value;
    if (!value) return;
    showModelInfo("checkpoint", value);
  });
}

// LoRA 행은 동적으로 계속 추가되므로, loraList 컨테이너에 이벤트를 위임해서
// 나중에 추가되는 행의 정보 버튼도 자동으로 동작하게 한다.
function initLoraInfoButtonDelegation() {
  document.getElementById("loraList").addEventListener("click", (e) => {
    const btn = e.target.closest(".lora-info-btn");
    if (!btn) return;
    const row = btn.closest(".lora-row");
    const value = row && row.querySelector(".lora-select").value;
    if (!value) return;
    showModelInfo("lora", value);
  });
}


function initPathPickerOverlay() {
  const backdrop = document.getElementById("pathPickerBackdrop");
  const closeBtn = document.getElementById("pathPickerCloseBtn");
  const searchInput = document.getElementById("pathPickerSearchInput");

  backdrop.addEventListener("click", closePathPicker);
  closeBtn.addEventListener("click", closePathPicker);
  searchInput.addEventListener("input", renderPathPicker);
}

// 체크포인트/LoRA select(hidden input)를 탭하면, 기존의 평범한 검색 드롭다운 대신
// 이 경로 피커 오버레이가 뜨도록 연결한다.
function initPathPickerTrigger(hidden, kind, title) {
  const display = hidden.previousElementSibling;
  if (!display) return;
  display.readOnly = true;
  display.style.cursor = "pointer";
  display.addEventListener("click", () => {
    pathPickerLockedScrollY = window.scrollY;
    const pickTitle = kind === "checkpoint" ? document.getElementById("ckptLabelText").textContent : title;
    openPathPicker(kind, hidden, pickTitle, (rawValue) => {
      setSearchableValue(hidden, rawValue);
      hidden.dispatchEvent(new Event("input", { bubbles: true }));
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
}

function initFamilyToggle() {
  document.querySelectorAll(".fam-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentFam = btn.getAttribute("data-fam");
      document.querySelectorAll(".fam-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      applyState(savedStates[currentFam] || {});
      Object.values(promptPillControllers).forEach((c) => c.forceSync());
      saveNow();
      loadGeneratedImages();
      refreshAllFilterDisplays();
    });
  });
}

// ---------- 스텝 / CFG 슬라이더 ----------

// ============================================================
// 슬라이더 + 숫자표시 공통 유틸
// - setRangeValue: 값이 현재 max보다 크면 max를 그 값까지 늘려서 설정
// - makeEditableSliderOutput: 숫자표시(span)를 누르면 직접 입력창으로 바뀌어
//   슬라이더 범위보다 큰 값도 자유롭게 입력할 수 있게 함
// ============================================================

function setRangeValue(range, value) {
  const v = parseFloat(value);
  if (!isNaN(v) && v > parseFloat(range.max)) range.max = v;
  range.value = isNaN(v) ? range.value : v;
}

function makeEditableSliderOutput(range, output, decimals) {
  output.style.cursor = "pointer";
  output.title = "눌러서 직접 입력";
  output.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "number";
    input.step = range.step || "1";
    input.value = range.value;
    input.style.cssText = "width:60px; font-size:12px; font-weight:500; text-align:right; margin:0; padding:2px 4px;";
    output.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      let v = parseFloat(input.value);
      const min = parseFloat(range.min);
      if (isNaN(v)) v = parseFloat(range.value);
      if (v < min) v = min;
      setRangeValue(range, v);
      output.textContent = decimals != null ? v.toFixed(decimals) : String(v);
      input.replaceWith(output);
      range.dispatchEvent(new Event("input", { bubbles: true }));
      saveNow();
    }
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    });
  });
}

function initSliders() {
  const stepsRange = document.getElementById("stepsRange");
  const stepsOut = document.getElementById("stepsOut");
  stepsRange.addEventListener("input", () => {
    stepsOut.textContent = stepsRange.value;
  });
  makeEditableSliderOutput(stepsRange, stepsOut, 0);

  const cfgRange = document.getElementById("cfgRange");
  const cfgOut = document.getElementById("cfgOut");
  cfgRange.addEventListener("input", () => {
    cfgOut.textContent = parseFloat(cfgRange.value).toFixed(1);
  });
  makeEditableSliderOutput(cfgRange, cfgOut, 1);
}

function autoGrowTextarea(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

function initAutoGrowTextareas() {
  document.querySelectorAll("textarea").forEach((el) => {
    autoGrowTextarea(el);
    el.addEventListener("input", () => autoGrowTextarea(el));
  });
}

// ---------- Hires ----------

let hiresAdvancedActive = false;

function updateHiresSummary() {
  const useOverride = hiresAdvancedActive;
  const cfg = useOverride
    ? document.getElementById("hiresCfgRange").value
    : document.getElementById("cfgRange").value;
  const sampler = useOverride
    ? document.getElementById("hiresSamplerSelect").value
    : document.getElementById("samplerSelect").value;
  const scheduler = useOverride
    ? document.getElementById("hiresSchedulerSelect").value
    : document.getElementById("schedulerSelect").value;
  document.getElementById("hiresAdvancedSummary").textContent =
    `CFG ${parseFloat(cfg || 0).toFixed(1)} · ${sampler || "-"} · ${scheduler || "-"}` +
    (useOverride ? "" : " (기본값)");
}

function initHiresControls() {
  const enabledCheckbox = document.getElementById("hiresEnabled");
  const body = document.getElementById("hiresBody");
  enabledCheckbox.addEventListener("change", () => {
    body.style.display = enabledCheckbox.checked ? "flex" : "none";
    saveNow();
  });

  const scaleRange = document.getElementById("hiresScaleRange");
  const scaleOut = document.getElementById("hiresScaleOut");
  scaleRange.addEventListener("input", () => {
    scaleOut.textContent = parseFloat(scaleRange.value).toFixed(2);
  });
  makeEditableSliderOutput(scaleRange, scaleOut, 2);

  const hStepsRange = document.getElementById("hiresStepsRange");
  const hStepsOut = document.getElementById("hiresStepsOut");
  hStepsRange.addEventListener("input", () => {
    hStepsOut.textContent = hStepsRange.value;
  });
  makeEditableSliderOutput(hStepsRange, hStepsOut, 0);

  const denoiseRange = document.getElementById("hiresDenoiseRange");
  const denoiseOut = document.getElementById("hiresDenoiseOut");
  denoiseRange.addEventListener("input", () => {
    denoiseOut.textContent = parseFloat(denoiseRange.value).toFixed(2);
  });
  makeEditableSliderOutput(denoiseRange, denoiseOut, 2);

  const advToggle = document.getElementById("hiresAdvancedToggle");
  const advPanel = document.getElementById("hiresAdvancedPanel");
  const hCfgRange = document.getElementById("hiresCfgRange");
  const hCfgOut = document.getElementById("hiresCfgOut");

  advToggle.addEventListener("click", () => {
    const willOpen = advPanel.style.display !== "flex";
    // 처음 열 때는 지금 base 값을 그대로 시작값으로 채워넣는다 (그 뒤로는 hires 전용 값으로 저장됨).
    if (willOpen && !hiresAdvancedActive) {
      hiresAdvancedActive = true;
      setRangeValue(hCfgRange, document.getElementById("cfgRange").value);
      setSearchableValue(document.getElementById("hiresSamplerSelect"), document.getElementById("samplerSelect").value);
      setSearchableValue(document.getElementById("hiresSchedulerSelect"), document.getElementById("schedulerSelect").value);
      hCfgOut.textContent = parseFloat(hCfgRange.value).toFixed(1);
      updateHiresSummary();
      saveNow();
    }
    advPanel.style.display = willOpen ? "flex" : "none";
    advToggle.classList.toggle("active", willOpen);
  });

  hCfgRange.addEventListener("input", () => {
    hCfgOut.textContent = parseFloat(hCfgRange.value).toFixed(1);
    updateHiresSummary();
  });
  makeEditableSliderOutput(hCfgRange, hCfgOut, 1);
}

function initBatchControls() {
  const batchInput = document.getElementById("batchInput");
  const batchMinus = document.getElementById("batchMinus");
  const batchPlus = document.getElementById("batchPlus");

  function clamp(v) {
    v = parseInt(v, 10);
    if (isNaN(v) || v < 1) v = 1;
    return v;
  }

  function step(multiply) {
    const v = clamp(batchInput.value);
    const next = multiply ? v * 2 : Math.max(1, Math.floor(v / 2));
    batchInput.value = next;
    batchInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  batchMinus.addEventListener("click", () => step(false));
  batchPlus.addEventListener("click", () => step(true));
  batchInput.addEventListener("change", () => {
    batchInput.value = clamp(batchInput.value);
  });
}

// ---------- 시드 ----------

function initSeedControls() {
  const seedInput = document.getElementById("seedInput");
  const seedUndo = document.getElementById("seedUndo");
  const seedMinus = document.getElementById("seedMinus");
  const seedPlus = document.getElementById("seedPlus");
  const randomizeSeed = document.getElementById("randomizeSeed");

  let previousSeed = null;
  let seedBeforeEdit = seedInput.value;

  function recordSeedChange(oldValue) {
    previousSeed = oldValue;
    seedUndo.disabled = false;
  }

  function stepSeed(delta) {
    const old = seedInput.value;
    let v = parseInt(seedInput.value.replace(/[^0-9]/g, ""), 10);
    if (isNaN(v)) v = 0;
    v = Math.max(0, v + delta);
    seedInput.value = v;
    recordSeedChange(old);
  }

  seedMinus.addEventListener("click", () => stepSeed(-1));
  seedPlus.addEventListener("click", () => stepSeed(1));

  seedInput.addEventListener("focus", () => {
    seedBeforeEdit = seedInput.value;
  });
  seedInput.addEventListener("change", () => {
    if (seedInput.value !== seedBeforeEdit) recordSeedChange(seedBeforeEdit);
  });

  seedUndo.addEventListener("click", () => {
    if (previousSeed === null) return;
    const current = seedInput.value;
    seedInput.value = previousSeed;
    previousSeed = current;
    saveNow();
  });

  // 랜덤 체크는 다른 UI를 비활성화하지 않는다.
  // 생성 버튼을 누를 때 시드 값만 새 난수로 변경한다.

  return { seedInput, randomizeSeed, recordSeedChange };
}

// ---------- 생성 결과 / 이미지 기록 ----------

let currentImageId = null;
let currentImageSettings = null;

// ============================================================
// 생성 이미지 테두리 글로우
// - 평소(선택 안 됨): 종류별로 옅은 고정 테두리 (일반은 테두리 없음)
// - 클릭한 순간: 잠깐 밝게 반짝였다가
// - 선택 유지 중: 다른 것들보다 살짝 더 밝은 고정 테두리로 안착 (반짝이지 않음)
// ============================================================

const GLOWS = {
  normal: {
    still: "none",
    selected: "0 0 6px 1.5px color-mix(in srgb, var(--fill-brand) 95%, transparent)",
    high: "0 0 14px 3px var(--fill-brand)",
  },
  hires: { still: "0 0 0 1.5px rgba(226,75,74,0.6)", selected: "0 0 7px 1.5px rgba(226,75,74,1)", high: "0 0 14px 3px #E24B4A" },
  upscale: { still: "0 0 0 1.5px rgba(55,138,221,0.6)", selected: "0 0 7px 1.5px rgba(55,138,221,1)", high: "0 0 14px 3px #378ADD" },
  both: { still: "0 0 0 1.5px rgba(127,119,221,0.6)", selected: "0 0 7px 1.5px rgba(127,119,221,1)", high: "0 0 14px 3px #7F77DD" },
};

function glowKind(item) {
  if (item.hires && item.upscale) return "both";
  if (item.upscale) return "upscale";
  if (item.hires) return "hires";
  return "normal";
}

function setGlowStill(el, kind) {
  if (el._glowFlashTimeout) {
    clearTimeout(el._glowFlashTimeout);
    el._glowFlashTimeout = null;
  }
  stopPreHiresAlternation(el);
  el.style.transition = "box-shadow 0.3s ease";
  el.style.boxShadow = GLOWS[kind].still;
}

function setGlowSelected(el, kind, animate) {
  if (el._glowFlashTimeout) clearTimeout(el._glowFlashTimeout);
  stopPreHiresAlternation(el);
  if (!animate) {
    el.style.transition = "box-shadow 0.3s ease";
    el.style.boxShadow = GLOWS[kind].selected;
    return;
  }
  el.style.transition = "box-shadow 0.15s ease-out";
  el.style.boxShadow = GLOWS[kind].high;
  el._glowFlashTimeout = setTimeout(() => {
    el.style.transition = "box-shadow 0.6s ease-in";
    el.style.boxShadow = GLOWS[kind].selected;
  }, 180);
}

let selectedThumbEl = null;

let currentHiresUrl = null;
let currentPreHiresUrl = null;
let viewingPreHires = false;

function renderCurrentImage(item, animate) {
  const currentResult = document.getElementById("currentResult");
  const resultImage = document.getElementById("resultImage");
  const resultStatus = document.getElementById("resultStatus");
  const deleteBtn = document.getElementById("deleteCurrentBtn");
  const reuseBtn = document.getElementById("reuseSettingsBtn");
  const upscaleBtn = document.getElementById("upscaleBtn");
  const upscaleSettingsBtn = document.getElementById("upscaleSettingsBtn");
  const preHiresToggleBtn = document.getElementById("preHiresToggleBtn");
  resultImage.className = "result-image";
  resultImage.innerHTML = "";
  if (item.settings && item.settings.width && item.settings.height) {
    resultImage.style.aspectRatio = `${item.settings.width} / ${item.settings.height}`;
  }

  const img = document.createElement("img");
  img.src = item.url;
  img.alt = "생성된 이미지";
  resultImage.appendChild(img);
  resultStatus.textContent = `생성 완료 · ${item.created_at || ""}`;

  currentImageId = item.id || null;
  currentImageSettings = item.settings || null;
  currentHiresUrl = item.url || null;
  currentPreHiresUrl = item.pre_hires_url || null;
  viewingPreHires = false;
  stopPreHiresAlternation(currentResult);

  deleteBtn.style.display = currentImageId ? "flex" : "none";
  reuseBtn.style.display = currentImageSettings ? "flex" : "none";
  upscaleSettingsBtn.style.display = currentImageId ? "flex" : "none";
  upscaleBtn.style.display = currentImageId ? "flex" : "none";
  upscaleBtn.disabled = !upscaleModels.length;
  upscaleBtn.style.opacity = upscaleModels.length ? "1" : "0.5";
  preHiresToggleBtn.style.display = currentPreHiresUrl ? "flex" : "none";
  preHiresToggleBtn.classList.remove("pre-hires-active");

  setGlowSelected(currentResult, glowKind(item), !!animate);
}

function hexToRgb(hex) {
  hex = (hex || "").trim().replace("#", "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const num = parseInt(hex, 16) || 0;
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

// hires 이전/이후 이미지 전환 시, 테두리가 주황(브랜드색)과 빨강 사이를
// 끊김 없이 부드럽게 섞여 오가고, 동시에 밝기(퍼짐 정도)도 커졌다 작아졌다 하도록 함
function startPreHiresAlternation(el) {
  stopPreHiresAlternation(el);
  const brandHex = getComputedStyle(document.documentElement).getPropertyValue("--fill-brand").trim() || "#c9552c";
  const c1 = hexToRgb(brandHex);
  const c2 = hexToRgb("#E24B4A");
  const colorPeriodMs = 2800; // 한쪽 색에서 반대쪽 색까지 가는 데 걸리는 시간
  const brightPeriodMs = 2000; // 밝기가 한 번 커졌다 작아지는 데 걸리는 시간
  const blurMin = 5, blurMax = 13;
  const spreadMin = 1.2, spreadMax = 2.6;
  const start = performance.now();
  el.style.transition = "none";

  function frame(now) {
    const elapsed = now - start;

    const t = (elapsed % (colorPeriodMs * 2)) / colorPeriodMs; // 0~2 사이 왕복
    const colorPhase = t <= 1 ? t : 2 - t; // 0→1→0 삼각파
    const colorEase = (1 - Math.cos(colorPhase * Math.PI)) / 2;
    const r = Math.round(c1[0] + (c2[0] - c1[0]) * colorEase);
    const g = Math.round(c1[1] + (c2[1] - c1[1]) * colorEase);
    const b = Math.round(c1[2] + (c2[2] - c1[2]) * colorEase);

    const bt = (elapsed % brightPeriodMs) / brightPeriodMs; // 0~1
    const brightEase = (1 - Math.cos(bt * Math.PI * 2)) / 2; // 0→1→0 사인 곡선
    const blur = blurMin + (blurMax - blurMin) * brightEase;
    const spread = spreadMin + (spreadMax - spreadMin) * brightEase;

    el.style.boxShadow = `0 0 ${blur.toFixed(1)}px ${spread.toFixed(1)}px rgb(${r}, ${g}, ${b})`;
    el._preHiresRaf = requestAnimationFrame(frame);
  }
  el._preHiresRaf = requestAnimationFrame(frame);
}

function stopPreHiresAlternation(el) {
  if (el._preHiresRaf) {
    cancelAnimationFrame(el._preHiresRaf);
    el._preHiresRaf = null;
  }
}

function reuseSettings(settings) {
  if (!settings) return;
  const fam = settings.family && modelsCache[settings.family] ? settings.family : currentFam;
  currentFam = fam;
  document.querySelectorAll(".fam-btn").forEach((b) =>
    b.classList.toggle("active", b.getAttribute("data-fam") === currentFam)
  );
  applyState(settings);
  Object.values(promptPillControllers).forEach((c) => c.forceSync());
  saveNow();
  refreshAllFilterDisplays();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function deleteImage(id) {
  if (!id) return;
  try {
    await fetch(`/api/generated-images/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (_) {}
  if (currentImageId === id) {
    currentImageId = null;
    currentImageSettings = null;
    document.getElementById("deleteCurrentBtn").style.display = "none";
    document.getElementById("reuseSettingsBtn").style.display = "none";
    document.getElementById("upscaleBtn").style.display = "none";
    document.getElementById("upscaleSettingsBtn").style.display = "none";
    document.getElementById("upscalePanel").style.display = "none";
    document.getElementById("resultImage").className = "result-image-placeholder";
    document.getElementById("resultImage").innerHTML = "이미지 미리보기";
    document.getElementById("resultStatus").textContent = "아직 생성된 이미지가 없습니다";
  }
  await loadGeneratedImages();
}

function renderHistory(items) {
  const history = document.getElementById("imageHistory");
  history.innerHTML = "";

  if (!items.length) {
    history.innerHTML = '<div class="history-empty">이전에 생성한 이미지가 여기에 표시됩니다.</div>';
    return;
  }

  items.forEach((item) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "history-card";
    card.title = `${item.created_at || ""} · seed ${item.seed || ""}`;

    const kind = glowKind(item);
    setGlowStill(card, kind);

    const img = document.createElement("img");
    img.src = item.url;
    img.alt = "이전 생성 이미지";
    img.loading = "lazy";

    const meta = document.createElement("span");
    meta.className = "history-meta";
    meta.textContent = item.seed ? `Seed ${item.seed}` : (item.created_at || "");

    card.appendChild(img);
    card.appendChild(meta);
    card.addEventListener("click", () => {
      renderCurrentImage(item, true);
      if (selectedThumbEl && selectedThumbEl !== card) {
        setGlowStill(selectedThumbEl, selectedThumbEl.dataset.glowKind);
      }
      card.dataset.glowKind = kind;
      setGlowSelected(card, kind, true);
      selectedThumbEl = card;
    });
    history.appendChild(card);
  });
}

async function loadGeneratedImages() {
  try {
    const res = await fetch(`/api/generated-images?family=${encodeURIComponent(currentFam)}`);
    if (!res.ok) return;
    const items = await res.json();
    renderHistory(items);
    if (items.length) {
      renderCurrentImage(items[0], false);
      const firstCard = document.querySelector("#imageHistory .history-card");
      if (firstCard) {
        firstCard.dataset.glowKind = glowKind(items[0]);
        setGlowSelected(firstCard, glowKind(items[0]), false);
        selectedThumbEl = firstCard;
      }
    } else {
      currentImageId = null;
      currentImageSettings = null;
      document.getElementById("deleteCurrentBtn").style.display = "none";
      document.getElementById("reuseSettingsBtn").style.display = "none";
      document.getElementById("upscaleBtn").style.display = "none";
      document.getElementById("upscaleSettingsBtn").style.display = "none";
      document.getElementById("upscalePanel").style.display = "none";
      document.getElementById("resultImage").className = "result-image-placeholder";
      document.getElementById("resultImage").innerHTML = "이미지 미리보기";
      document.getElementById("resultStatus").textContent = "아직 생성된 이미지가 없습니다";
      setGlowStill(document.getElementById("currentResult"), "normal");
      selectedThumbEl = null;
    }
  } catch (_) {}
}


function setGenerationProgress(overallPct, stepPct) {
  document.getElementById("progressBar").style.setProperty("--pct", `${overallPct}%`);
  document.getElementById("stepProgressBar").style.setProperty("--pct", `${stepPct != null ? stepPct : 0}%`);
}

function renderBatchDots(completed, total) {
  const row = document.getElementById("batchDots");
  row.innerHTML = "";
  if (total <= 1) return;
  for (let i = 0; i < total; i++) {
    const dot = document.createElement("span");
    dot.style.cssText = "width:6px; height:6px; border-radius:50%; display:inline-block;";
    dot.style.background = i < completed ? "var(--fill-brand)" : "var(--border-strong)";
    row.appendChild(dot);
  }
}

function initUpscaleControls() {
  const settingsBtn = document.getElementById("upscaleSettingsBtn");
  const panel = document.getElementById("upscalePanel");
  const wrap = document.getElementById("upscaleModelWrap");
  const errorMsg = document.getElementById("upscaleModelError");
  const upscaleBtn = document.getElementById("upscaleBtn");
  const resultStatus = document.getElementById("resultStatus");
  const progressTrack = document.getElementById("progressTrack");

  settingsBtn.addEventListener("click", () => {
    const willShow = panel.style.display === "none";
    panel.style.display = willShow ? "block" : "none";
    if (willShow) {
      const hasModels = upscaleModels.length > 0;
      wrap.style.display = hasModels ? "block" : "none";
      errorMsg.style.display = hasModels ? "none" : "block";
    }
  });

  upscaleBtn.addEventListener("click", async () => {
    if (upscaleBtn.disabled || !currentImageId) return;
    const modelName = document.getElementById("upscaleModelSelect").value;
    if (!modelName) return;

    upscaleBtn.disabled = true;
    settingsBtn.disabled = true;
    const prevText = upscaleBtn.innerHTML;
    upscaleBtn.innerHTML = "업스케일 중...";
    progressTrack.style.display = "flex";
    setGenerationProgress(0, 0);
    resultStatus.textContent = "업스케일 중 · 브라우저를 닫아도 서버에서 계속 진행됩니다";

    try {
      const res = await fetch("/api/upscale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_id: currentImageId, model_name: modelName }),
      });
      const data = await res.json();
      if (!res.ok || data.error || !data.job_id) throw new Error(data.error || "업스케일 요청 실패");

      for (let i = 0; i < 900; i++) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const statusRes = await fetch(`/api/generate/${encodeURIComponent(data.job_id)}`);
        if (!statusRes.ok) continue;
        const status = await statusRes.json();
        setGenerationProgress(status.overall != null ? status.overall : 0, status.step);

        if (status.status === "completed") {
          progressTrack.style.display = "none";
          resultStatus.textContent = "업스케일 완료";
          await loadGeneratedImages();
          break;
        }
        if (status.status === "error") throw new Error(status.error || "업스케일 실패");
      }
    } catch (err) {
      progressTrack.style.display = "none";
      resultStatus.textContent = "오류: " + err.message;
    } finally {
      upscaleBtn.disabled = !upscaleModels.length;
      settingsBtn.disabled = false;
      upscaleBtn.innerHTML = prevText;
    }
  });
}

function initGenerate(seedApi) {
  const resultImage = document.getElementById("resultImage");
  const resultStatus = document.getElementById("resultStatus");
  const progressTrack = document.getElementById("progressTrack");
  const genBtn = document.getElementById("genBtn");
  const widthInput = document.getElementById("widthInput");
  const heightInput = document.getElementById("heightInput");

  let currentJobId = null;
  let running = false;

  function setRunningUI(isRunning) {
    running = isRunning;
    genBtn.textContent = isRunning ? "중지" : "생성";
    genBtn.classList.toggle("stop-mode", isRunning);
  }

  // 생성 중 블러 연출 on/off. 지금은 기본값 off로 두고, 토글 버튼은 나중에 추가한다.
  let resultBlurEffectEnabled = false;

  async function pollJob(jobId) {
    let lastCompleted = 0;
    let previewShown = false;
    let maxStepSeen = 0; // 노드가 바뀌면서 step이 0으로 리셋되어도, 블러가 도로 풀리지 않도록 최고값만 추적
    for (let i = 0; i < 3600; i++) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const statusRes = await fetch(`/api/generate/${encodeURIComponent(jobId)}`);
      if (!statusRes.ok) continue;
      const status = await statusRes.json();
      const total = status.total || 1;
      const completed = status.completed || 0;

      renderBatchDots(completed, total);
      setGenerationProgress(status.overall != null ? status.overall : 0, status.step);
      resultStatus.textContent =
        (status.status === "stopped" ? "중지 중 · " : "") +
        `${completed} / ${total} 생성 · 브라우저를 닫아도 서버에서 계속 진행됩니다`;

      // hires 사용 시: base 단계 이미지가 완성되는 즉시 미리보기로 보여주고,
      // hires 진행도가 올라갈수록 블러를 점점 없애서 서서히 선명해지는 느낌을 준다.
      if (status.preview_url && !previewShown) {
        resultImage.innerHTML = "";
        const previewImg = document.createElement("img");
        previewImg.id = "hiresPreviewImg";
        previewImg.alt = "생성 중 미리보기";
        previewImg.src = status.preview_url;
        previewImg.style.transition = "filter 0.2s linear";
        resultImage.appendChild(previewImg);
        previewShown = true;
        maxStepSeen = 0;
      }
      if (previewShown) {
        const previewImg = document.getElementById("hiresPreviewImg");
        if (previewImg) {
          if (!resultBlurEffectEnabled) {
            previewImg.style.filter = "none";
          } else if (status.stage === "hires") {
            const stepPct = status.step != null ? status.step : 0;
            maxStepSeen = Math.max(maxStepSeen, stepPct);
            // hires 진입 직후 바로 블러가 훅 들어가면 어색하니, 진행률이 5%를
            // 넘어선 순간부터 블러를 시작한다. 이후로는 최고 진행률 기준으로만
            // 줄어들어서(절대 다시 늘어나지 않음) 이전 이미지가 화면에 남아있는
            // 동안 블러가 풀렸다 다시 들어가는 일이 없게 한다.
            if (maxStepSeen <= 5) {
              previewImg.style.filter = "none";
            } else {
              const adjusted = (maxStepSeen - 5) / 95;
              previewImg.style.filter = `blur(${Math.max(0, 16 * (1 - adjusted))}px)`;
            }
          } else {
            previewImg.style.filter = "none";
          }
        }
      } else if (resultBlurEffectEnabled && status.status !== "completed" && status.status !== "stopped" && status.status !== "error") {
        // hires 가 아닌 일반 생성 중에는, 아직 화면에 남아있는 이전 이미지 위에
        // 진행률이 올라갈수록 블러를 점점 강하게 걸어서 "새 이미지가 만들어지고
        // 있다"는 느낌을 준다. 최종 블러 강도는 hires 시작 블러와 동일한 16px.
        // step은 노드가 바뀔 때마다 0으로 리셋되는데, 그대로 쓰면 화면에 남아있는
        // 이전 이미지의 블러가 중간에 풀렸다가 완성 직전에 다시 들어가는 것처럼
        // 보인다. 그래서 지금까지 본 것 중 가장 높은 값만 추적해서 절대 줄어들지
        // 않게 하고, 새 이미지가 진짜로 로드됐을 때만 자연스럽게 사라지게 한다.
        const oldImg = resultImage.querySelector("img");
        if (oldImg) {
          const stepPct = status.step != null ? status.step : 0;
          maxStepSeen = Math.max(maxStepSeen, stepPct);
          oldImg.style.transition = "filter 0.2s linear";
          oldImg.style.filter = `blur(${Math.min(16, (maxStepSeen / 100) * 16)}px)`;
        }
      }

      if (completed > lastCompleted) {
        lastCompleted = completed;
        await loadGeneratedImages();
        previewShown = false;
        maxStepSeen = 0;
      }

      if (status.status === "completed") {
        progressTrack.style.display = "none";
        resultStatus.textContent = `${total} / ${total} 생성 완료`;
        return;
      }
      if (status.status === "stopped") {
        progressTrack.style.display = "none";
        resultStatus.textContent = `중지됨 · ${completed} / ${total} 생성됨`;
        return;
      }
      if (status.status === "error") {
        throw new Error(status.error || "생성 실패");
      }
    }
    throw new Error("생성 시간이 초과되었습니다.");
  }

  genBtn.addEventListener("click", async () => {
    if (running) {
      // 중지 버튼으로 눌린 경우: 남은 배치를 중단하고 ComfyUI 현재 작업도 즉시 인터럽트
      genBtn.disabled = true;
      resultStatus.textContent = "중지하는 중...";
      try {
        if (currentJobId) await fetch(`/api/generate/${encodeURIComponent(currentJobId)}/stop`, { method: "POST" });
      } catch (_) {}
      genBtn.disabled = false;
      return;
    }

    if (seedApi.randomizeSeed.checked) {
      const old = seedApi.seedInput.value;
      const newSeed = Math.floor(Math.random() * 900000000000000) + 100000000000000;
      seedApi.seedInput.value = newSeed;
      seedApi.recordSeedChange(old);
    }
    saveNow();

    // 태그 모드에서 수정한 내용이 텍스트 모드로 돌아가지 않아도 실제 생성에 반영되도록,
    // 생성 직전에 두 프롬프트 모두 textarea 값을 강제로 최신화한다.
    Object.values(promptPillControllers).forEach((c) => c.syncToTextarea());

    resultImage.style.aspectRatio = `${widthInput.value} / ${heightInput.value}`;
    // 이전 이미지가 hires였다면 그 전환 버튼이 새로 생성 중인 이미지 위에 남아있으면 안 되므로 숨긴다.
    document.getElementById("preHiresToggleBtn").style.display = "none";
    currentPreHiresUrl = null;
    viewingPreHires = false;
    progressTrack.style.display = "flex";
    setGenerationProgress(0, 0);
    resultStatus.textContent = "생성 중 · 브라우저를 닫아도 서버에서 계속 생성됩니다";
    setRunningUI(true);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectState()),
      });
      const data = await res.json();
      if (!res.ok || data.error || !data.job_id) {
        throw new Error(data.error || "생성 요청 실패");
      }
      currentJobId = data.job_id;
      await pollJob(currentJobId);
    } catch (err) {
      resultStatus.textContent = "오류: " + err.message;
      progressTrack.style.display = "none";
    } finally {
      setRunningUI(false);
      currentJobId = null;
    }
  });
}

// ---------- 스크롤 시에만 나타나는 얇은 인디케이터 ----------

function initScrollThumb() {
  const thumb = document.getElementById("scrollThumb");
  let fadeTimer = null;

  function update() {
    const doc = document.documentElement;
    const trackHeight = window.innerHeight;
    const contentHeight = doc.scrollHeight;

    if (contentHeight <= trackHeight) {
      thumb.style.opacity = "0";
      return;
    }

    const thumbHeight = Math.max(24, (trackHeight / contentHeight) * trackHeight);
    const maxScroll = contentHeight - trackHeight;
    const maxTravel = trackHeight - thumbHeight;
    const ratio = maxScroll > 0 ? window.scrollY / maxScroll : 0;

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.top = `${ratio * maxTravel}px`;
    thumb.style.opacity = "1";

    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      thumb.style.opacity = "0";
    }, 800);
  }

  window.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  update();
}

// ============================================================
// 기기별 마지막 설정 저장 / 복원
// 서버가 쿠키(device_id)로 이 브라우저를 구분해서
// data/device_states.json 에 마지막 값을 저장해둡니다.
// ============================================================

function collectState() {
  // 지금 텍스트/태그 어느 모드든 상관없이, 저장되는 값이 항상 최신 상태(줄바꿈 포함)를
  // 반영하도록 강제로 동기화한다. 이걸 안 하면 태그 모드에서 편집한 내용(특히 줄바꿈처럼
  // textarea에는 반영 안 된 상태로만 존재하는 것)이 자동저장 타이밍에 따라 간헐적으로
  // 사라질 수 있었다.
  Object.values(promptPillControllers).forEach((c) => c.syncToTextarea());

  const loras = Array.from(document.querySelectorAll("#loraList .lora-row")).map((row) => ({
    file: row.querySelector(".lora-select").value,
    strengthModel: parseFloat(row.querySelector(".lora-strength-model").value),
    strengthClip: parseFloat(row.querySelector(".lora-strength-clip").value),
    advanced: row.querySelector(".lora-advanced-panel").style.display === "flex",
  }));

  return {
    family: currentFam,
    checkpoint: document.getElementById("ckptSelect").value,
    clip: document.getElementById("clipSelect").value,
    vae: document.getElementById("vaeSelect").value,
    clipSkip:
      currentFam !== "anima" && document.getElementById("clipSkipToggle").classList.contains("active")
        ? document.getElementById("clipSkipInput").value
        : null,
    loras,
    regions: collectRegionsState(),
    positivePrompt: document.getElementById("positivePrompt").value,
    negativePrompt: document.getElementById("negativePrompt").value,
    width: document.getElementById("widthInput").value,
    height: document.getElementById("heightInput").value,
    batch: document.getElementById("batchInput").value,
    sampler: document.getElementById("samplerSelect").value,
    scheduler: document.getElementById("schedulerSelect").value,
    steps: document.getElementById("stepsRange").value,
    cfg: document.getElementById("cfgRange").value,
    seed: document.getElementById("seedInput").value,
    randomizeSeed: document.getElementById("randomizeSeed").checked,
    hires: {
      enabled: document.getElementById("hiresEnabled").checked,
      upscaleMethod: document.getElementById("hiresUpscaleMethodSelect").value,
      scaleBy: parseFloat(document.getElementById("hiresScaleRange").value),
      steps: parseInt(document.getElementById("hiresStepsRange").value, 10),
      denoise: parseFloat(document.getElementById("hiresDenoiseRange").value),
      advancedActive: hiresAdvancedActive,
      cfg: hiresAdvancedActive ? parseFloat(document.getElementById("hiresCfgRange").value) : null,
      sampler: hiresAdvancedActive ? document.getElementById("hiresSamplerSelect").value : null,
      scheduler: hiresAdvancedActive ? document.getElementById("hiresSchedulerSelect").value : null,
    },
  };
}

function applyState(state) {
  state = state || {};
  updateCkptSection();
  updateAdvancedSection();

  const ckptSelect = document.getElementById("ckptSelect");
  setSearchableValue(ckptSelect, pickValidOr(ckptSelect, state.checkpoint));

  const clipSelect = document.getElementById("clipSelect");
  if (currentFam === "anima") {
    setSearchableValue(clipSelect, pickValidOr(clipSelect, state.clip));
  }

  const vaeSelect = document.getElementById("vaeSelect");
  setSearchableValue(vaeSelect, pickValidOr(vaeSelect, state.vae));

  const clipSkipToggle = document.getElementById("clipSkipToggle");
  const clipSkipRow = document.getElementById("clipSkipRow");
  const clipSkipInput = document.getElementById("clipSkipInput");
  const hasClipSkip =
    currentFam !== "anima" &&
    state.clipSkip !== null &&
    state.clipSkip !== undefined &&
    state.clipSkip !== "";
  clipSkipToggle.classList.toggle("active", hasClipSkip);
  clipSkipRow.style.display = hasClipSkip ? "block" : "none";
  clipSkipInput.value = hasClipSkip ? state.clipSkip : "";

  document.getElementById("loraList").innerHTML = "";
  (state.loras || []).forEach((l) => addLora(l));
  renumberLoras();

  document.getElementById("positivePrompt").value = state.positivePrompt || "";
  document.getElementById("negativePrompt").value = state.negativePrompt || "";
  autoGrowTextarea(document.getElementById("positivePrompt"));
  autoGrowTextarea(document.getElementById("negativePrompt"));
  document.getElementById("widthInput").value = state.width || 960;
  document.getElementById("heightInput").value = state.height || 1280;
  document.getElementById("batchInput").value = state.batch || 1;

  // Anima는 euler_ancestral / beta 가 보편적인 기본값이라 목록에 있으면 우선 선택한다.
  const samplerSelect = document.getElementById("samplerSelect");
  setSearchableValue(
    samplerSelect,
    pickValidOr(samplerSelect, state.sampler, (opts) => {
      const pref = currentFam === "anima" && opts.find((o) => o.value === "euler_ancestral");
      return pref ? pref.value : opts[0] ? opts[0].value : "";
    })
  );
  const schedulerSelect = document.getElementById("schedulerSelect");
  setSearchableValue(
    schedulerSelect,
    pickValidOr(schedulerSelect, state.scheduler, (opts) => {
      const pref = currentFam === "anima" && opts.find((o) => o.value === "beta");
      return pref ? pref.value : opts[0] ? opts[0].value : "";
    })
  );

  const defaultSteps = currentFam === "il" ? 30 : 24;
  const defaultCfg = currentFam === "il" ? 8.0 : 5;

  const stepsRange = document.getElementById("stepsRange");
  setRangeValue(stepsRange, state.steps || defaultSteps);
  document.getElementById("stepsOut").textContent = stepsRange.value;

  const cfgRange = document.getElementById("cfgRange");
  setRangeValue(cfgRange, state.cfg || defaultCfg);
  document.getElementById("cfgOut").textContent = parseFloat(cfgRange.value).toFixed(1);

  const seedInputEl = document.getElementById("seedInput");
  seedInputEl.value = state.seed || "";

  const randomizeSeed = document.getElementById("randomizeSeed");
  // 저장된 값이 없으면(처음 접속) 랜덤을 기본으로 켠다.
  randomizeSeed.checked = state.randomizeSeed !== undefined ? !!state.randomizeSeed : true;
  randomizeSeed.dispatchEvent(new Event("change"));

  // 시드칸이 비어있으면(정말 처음 접속) 한 번 랜덤 시드를 만들어 채워두고 저장해둔다.
  if (!seedInputEl.value) {
    seedInputEl.value = Math.floor(Math.random() * 900000000000000) + 100000000000000;
    saveNow();
  }

  const hires = state.hires || {};
  const hiresEnabledEl = document.getElementById("hiresEnabled");
  hiresEnabledEl.checked = !!hires.enabled;
  document.getElementById("hiresBody").style.display = hires.enabled ? "flex" : "none";

  const hiresMethodHidden = document.getElementById("hiresUpscaleMethodSelect");
  setSearchableValue(
    hiresMethodHidden,
    pickValidOr(hiresMethodHidden, hires.upscaleMethod, (opts) => {
      const pref = opts.find((o) => o.value === "bilinear");
      return pref ? pref.value : opts[0] ? opts[0].value : "";
    })
  );

  const hiresScaleRangeEl = document.getElementById("hiresScaleRange");
  setRangeValue(hiresScaleRangeEl, hires.scaleBy || 1.25);
  document.getElementById("hiresScaleOut").textContent = parseFloat(hiresScaleRangeEl.value).toFixed(2);

  const hiresStepsRangeEl = document.getElementById("hiresStepsRange");
  setRangeValue(hiresStepsRangeEl, hires.steps || 20);
  document.getElementById("hiresStepsOut").textContent = hiresStepsRangeEl.value;

  const hiresDenoiseRangeEl = document.getElementById("hiresDenoiseRange");
  setRangeValue(hiresDenoiseRangeEl, hires.denoise != null ? hires.denoise : 0.45);
  document.getElementById("hiresDenoiseOut").textContent = parseFloat(hiresDenoiseRangeEl.value).toFixed(2);

  hiresAdvancedActive = !!hires.advancedActive;
  const hiresCfgRangeEl = document.getElementById("hiresCfgRange");
  const hiresSamplerHidden = document.getElementById("hiresSamplerSelect");
  const hiresSchedulerHidden = document.getElementById("hiresSchedulerSelect");
  if (hiresAdvancedActive) {
    setRangeValue(hiresCfgRangeEl, hires.cfg != null ? hires.cfg : cfgRange.value);
    setSearchableValue(hiresSamplerHidden, hires.sampler || samplerSelect.value);
    setSearchableValue(hiresSchedulerHidden, hires.scheduler || schedulerSelect.value);
  } else {
    setRangeValue(hiresCfgRangeEl, cfgRange.value);
    setSearchableValue(hiresSamplerHidden, samplerSelect.value);
    setSearchableValue(hiresSchedulerHidden, schedulerSelect.value);
  }
  document.getElementById("hiresCfgOut").textContent = parseFloat(hiresCfgRangeEl.value).toFixed(1);
  document.getElementById("hiresAdvancedPanel").style.display = "none";
  document.getElementById("hiresAdvancedToggle").classList.remove("active");
  updateHiresSummary();

  applyRegionsState(state.regions || []);
}

function saveState(state) {
  fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  }).catch(() => {});
}

function saveNow() {
  savedStates[currentFam] = collectState();
  savedStates.lastFamily = currentFam;
  saveState(savedStates);
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

function initAutosave() {
  // 텍스트 입력, 슬라이더, 드롭다운 등 대부분의 변경은 여기서 한번에 잡아서
  // 600ms 동안 추가 입력이 없으면 저장합니다 (타이핑 중 매 글자마다 저장하지 않도록).
  document.addEventListener("input", (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) {
      scheduleSave();
      if (["cfgRange", "samplerSelect", "schedulerSelect"].includes(e.target.id)) updateHiresSummary();
    }
  });
  document.addEventListener("change", (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) scheduleSave();
  });
}

// ---------- 초기화 ----------

document.addEventListener("DOMContentLoaded", async () => {
  await Promise.all([loadModels(), loadSamplers(), loadUpscaleModels(), loadHiresOptions()]);

  savedStates = await fetch("/api/state")
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  if (!savedStates || typeof savedStates !== "object") savedStates = {};

  currentFam =
    savedStates.lastFamily && modelsCache[savedStates.lastFamily] ? savedStates.lastFamily : "anima";
  document.querySelectorAll(".fam-btn").forEach((b) =>
    b.classList.toggle("active", b.getAttribute("data-fam") === currentFam)
  );
  applyState(savedStates[currentFam] || {});

  [
    "clipSelect",
    "vaeSelect",
    "samplerSelect",
    "schedulerSelect",
    "upscaleModelSelect",
    "hiresUpscaleMethodSelect",
    "hiresSamplerSelect",
    "hiresSchedulerSelect",
  ].forEach((id) => {
    initSearchableSelect(document.getElementById(id));
  });

  initPathPickerTrigger(document.getElementById("ckptSelect"), "checkpoint", "체크포인트 선택");
  initPathPickerOverlay();
  initModelInfoOverlay();
  initRegionSection();
  initWfSavePanel();
  initWfLoadPanel();
  initWfDeleteConfirm();
  initResPresetPanel();
  initResSwap("widthInput", "heightInput", "resSwapBtn");
  initResSwap("resPresetWInput", "resPresetHInput", "resPresetSwapBtn");
  initSnap8("widthInput");
  initSnap8("heightInput");

  // 해상도를 실시간으로 조정할 때, 영역별 프롬프트 캔버스와(아직 생성된 이미지가 없어서
  // 플레이스홀더만 떠 있는 경우) 결과 미리보기 박스의 비율도 함께 즉시 반영한다.
  function syncPreviewAspectRatioToInputs() {
    const regionsChanged = clampRegionsToCanvas();
    renderRegionCanvas();
    if (regionsChanged) saveNow();
    const resultImageEl = document.getElementById("resultImage");
    if (resultImageEl && !resultImageEl.querySelector("img")) {
      const w = document.getElementById("widthInput").value;
      const h = document.getElementById("heightInput").value;
      resultImageEl.style.aspectRatio = `${w} / ${h}`;
    }
  }
  document.getElementById("widthInput").addEventListener("input", syncPreviewAspectRatioToInputs);
  document.getElementById("heightInput").addEventListener("input", syncPreviewAspectRatioToInputs);
  initSnap8("resPresetWInput");
  initSnap8("resPresetHInput");
  initModelPathsSettings();
  initCkptInfoButton();
  initLoraInfoButtonDelegation();

  initFamilyToggle();
  initLoraFilterSettings();
  initSliders();
  initBatchControls();
  initUpscaleControls();
  initHiresControls();
  initAutoGrowTextareas();
  initTagSearch();
  initInlinePromptAutocomplete("positivePrompt", "positivePromptAc");
  initInlinePromptAutocomplete("negativePrompt", "negativePromptAc");
  initPromptPillEditor("positive", false);
  initPromptPillEditor("negative", true);
  initSharedPromptModeToggle();
  initSharedPreviewToggle();
  const seedApi = initSeedControls();
  initGenerate(seedApi);
  loadGeneratedImages();
  initScrollThumb();
  initAutosave();

  document.getElementById("addLora").addEventListener("click", () => {
    addLora();
    saveNow();
  });

  document.getElementById("clipSkipToggle").addEventListener("click", () => {
    const toggle = document.getElementById("clipSkipToggle");
    const row = document.getElementById("clipSkipRow");
    const isOn = toggle.classList.toggle("active");
    row.style.display = isOn ? "block" : "none";
    if (!isOn) document.getElementById("clipSkipInput").value = "";
    saveNow();
  });

  document.getElementById("deleteCurrentBtn").addEventListener("click", () => {
    deleteImage(currentImageId);
  });

  document.getElementById("preHiresToggleBtn").addEventListener("click", () => {
    if (!currentPreHiresUrl) return;
    const currentResult = document.getElementById("currentResult");
    const toggleBtn = document.getElementById("preHiresToggleBtn");
    const img = document.querySelector("#resultImage img");
    viewingPreHires = !viewingPreHires;

    if (img) img.src = viewingPreHires ? currentPreHiresUrl : currentHiresUrl;
    toggleBtn.classList.toggle("pre-hires-active", viewingPreHires);

    if (viewingPreHires) {
      startPreHiresAlternation(currentResult);
      document.getElementById("resultStatus").textContent = "hires 적용 전 이미지";
    } else {
      stopPreHiresAlternation(currentResult);
      setGlowSelected(currentResult, "hires", false);
      document.getElementById("resultStatus").textContent = `생성 완료`;
    }
  });

  document.getElementById("reuseSettingsBtn").addEventListener("click", () => {
    reuseSettings(currentImageSettings);
  });

  const resetBtn = document.getElementById("resetBtn");
  const resetConfirm = document.getElementById("resetConfirm");
  resetBtn.addEventListener("click", () => {
    resetConfirm.style.display = "flex";
  });
  document.getElementById("resetCancel").addEventListener("click", () => {
    resetConfirm.style.display = "none";
  });
  document.getElementById("resetConfirmBtn").addEventListener("click", async () => {
    try {
      await fetch("/api/reset", { method: "POST" });
    } catch (_) {}
    location.reload();
  });

  document.getElementById("clearHistoryBtn").addEventListener("click", async () => {
    if (!confirm(`${currentFam === "anima" ? "Anima" : "Illustrious"} 계열의 이전 생성 이미지를 모두 삭제할까요?`)) return;
    try {
      await fetch("/api/generated-images/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ family: currentFam }),
      });
    } catch (_) {}
    await loadGeneratedImages();
  });
});
