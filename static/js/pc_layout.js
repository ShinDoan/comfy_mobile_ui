// PC(가로 화면) 레이아웃 전용 스크립트.
//
// 가로로 긴 화면에서는 "왼쪽 설정 패널"과 "이미지 영역" 사이에 보조 패널이 하나 열린다.
// 보조 패널이 되는 것:
//   태그 검색 / 경로 선택 / 모델·LoRA 정보 / 워크플로우 저장·불러오기 / 해상도 프리셋 (기존 바텀시트)
//   경로 설정 / Hires 설정 / 영역별 프롬프트 (기존에는 그 자리에서 펼쳐지던 영역)
// 이 스크립트는 기존 열기/닫기 코드를 건드리지 않고, 열린 상태를 감시만 한다.
//   1) 한 번에 하나만 열려 있도록 나머지를 닫고
//   2) 열려 있는 동안 body 에 pc-side-open 클래스를 붙여 이미지 영역을 옆으로 밀어낸다.
// 세로 화면(모바일)에서는 아무 일도 하지 않는다.
(function () {
  "use strict";

  const mq = window.matchMedia("(min-aspect-ratio: 1/1) and (min-width: 900px)");
  const $ = (id) => document.getElementById(id);
  const isShown = (el) => !!el && getComputedStyle(el).display !== "none";

  const panels = [];

  // 기존 바텀시트 오버레이들: .open 클래스로 열림/닫힘을 관리하고, 닫기 버튼은 .tag-overlay-close
  ["tagOverlayPanel", "pathPickerPanel", "modelInfoPanel", "wfSavePanel", "wfLoadPanel", "resPresetPanel"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    panels.push({
      key: id,
      el,
      isOpen: () => el.classList.contains("open"),
      close: () => {
        const btn = el.querySelector(".tag-overlay-close");
        if (btn) btn.click();
      },
    });
  });

  // 경로 설정: style.display 가 block 일 때 열림. 토글 버튼을 눌러 닫는다.
  const pathsSection = $("modelPathsSection");
  const pathsToggle = $("modelPathsSettingsToggle");
  if (pathsSection && pathsToggle) {
    panels.push({
      key: "modelPaths",
      el: pathsSection,
      isOpen: () => isShown(pathsSection),
      close: () => pathsToggle.click(),
    });
  }

  // Hires: 체크박스 = "사용 여부", 보조 패널의 표시 여부는 pc-side-hidden 클래스로 따로 관리한다.
  // (다른 패널을 열려고 Hires 패널을 닫아도 Hires 사용 설정 자체는 꺼지면 안 되기 때문)
  const hiresCheck = $("hiresEnabled");
  const hiresBody = $("hiresBody");
  const hiresBtn = $("hiresPanelBtn");
  if (hiresCheck && hiresBody) {
    panels.push({
      key: "hires",
      el: hiresBody,
      isOpen: () => isShown(hiresBody),
      close: () => hiresBody.classList.add("pc-side-hidden"),
    });
    // 체크하는 순간 패널이 열리고, 체크를 풀면 사용 해제 + 패널도 사라진다.
    hiresCheck.addEventListener("change", () => {
      hiresBody.classList.toggle("pc-side-hidden", !hiresCheck.checked);
    });
    if (hiresBtn) {
      hiresBtn.addEventListener("click", () => hiresBody.classList.remove("pc-side-hidden"));
    }
  }

  // 영역별 프롬프트: 라벨을 눌러 접고 펼치는 기존 동작을 그대로 쓴다.
  const regionBody = $("regionSectionBody");
  const regionLabel = $("regionSectionLabel");
  if (regionBody && regionLabel) {
    panels.push({
      key: "region",
      el: regionBody,
      isOpen: () => isShown(regionBody),
      close: () => regionLabel.click(),
    });
  }

  // 보조 패널 안의 ✕ 버튼 (Hires / 영역)
  document.querySelectorAll("[data-pc-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = panels.find((x) => x.key === btn.dataset.pcClose);
      if (p) p.close();
    });
  });

  let prev = new Set();
  let busy = false;

  function syncHiresButton() {
    if (!hiresBtn || !hiresCheck || !hiresBody) return;
    hiresBtn.hidden = !(hiresCheck.checked && hiresBody.classList.contains("pc-side-hidden"));
  }

  function evaluate() {
    if (busy) return;
    syncHiresButton();
    const open = new Set(panels.filter((p) => p.isOpen()).map((p) => p.key));
    if (!mq.matches) {
      document.body.classList.remove("pc-side-open");
      prev = open;
      return;
    }
    const added = [...open].filter((k) => !prev.has(k));
    let keep = open;
    if (added.length) {
      // 방금 열린 패널만 남기고 나머지는 닫는다.
      keep = new Set([added[added.length - 1]]);
      busy = true;
      try {
        panels.forEach((p) => {
          if (open.has(p.key) && !keep.has(p.key)) p.close();
        });
      } finally {
        busy = false;
      }
    }
    prev = new Set(keep);
    document.body.classList.toggle("pc-side-open", prev.size > 0);
  }

  // ------------------------------------------------------------
  // iOS 스타일 스크롤 막대
  // 기본 스크롤바는 CSS 로 숨겨져 있고, 어떤 영역이든 세로로 스크롤되는 동안
  // 그 영역의 오른쪽 가장자리에 얇은 막대를 띄웠다가 멈추면 서서히 지운다.
  // (scroll 이벤트는 버블링되지 않아서 capture 단계에서 한 번에 받는다)
  // ------------------------------------------------------------
  const thumb = document.createElement("div");
  thumb.id = "pcScrollThumb";
  thumb.setAttribute("aria-hidden", "true");
  document.body.appendChild(thumb);

  const lastTop = new WeakMap();
  let fadeTimer = null;

  document.addEventListener(
    "scroll",
    (e) => {
      if (!mq.matches) return;
      const el = e.target;
      if (!(el instanceof HTMLElement)) return; // 문서 전체 스크롤은 무시
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return;
      // 가로 스크롤(scrollTop 변화 없음)은 막대를 띄우지 않는다.
      const prevTop = lastTop.get(el);
      lastTop.set(el, el.scrollTop);
      if (prevTop === el.scrollTop) return;
      const ch = el.clientHeight;
      const sh = el.scrollHeight;
      if (sh <= ch + 1) return;
      const r = el.getBoundingClientRect();
      const h = Math.max(36, (ch * ch) / sh);
      const travel = Math.max(0, ch - h - 8);
      thumb.style.height = h + "px";
      thumb.style.top = r.top + 4 + (el.scrollTop / (sh - ch)) * travel + "px";
      thumb.style.left = r.right - 6 + "px";
      thumb.style.opacity = "1";
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(() => {
        thumb.style.opacity = "0";
      }, 800);
    },
    true
  );

  // ------------------------------------------------------------
  // iOS 스타일 슬라이더: 채워진 구간 길이를 CSS 변수(--pn)로 알려준다.
  // 값이 코드로 바뀌는 경우(설정 복원 등)도 있어서 가볍게 주기적으로 맞춰준다.
  // ------------------------------------------------------------
  function syncRange(input) {
    const min = parseFloat(input.min || "0");
    const max = parseFloat(input.max || "100");
    const v = parseFloat(input.value);
    const pn = max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0;
    const txt = pn.toFixed(4);
    if (input.dataset.pn !== txt) {
      input.dataset.pn = txt;
      input.style.setProperty("--pn", txt);
    }
  }
  function syncAllRanges() {
    if (!mq.matches) return;
    document.querySelectorAll('input[type="range"]').forEach(syncRange);
  }
  document.addEventListener("input", (e) => {
    if (e.target && e.target.type === "range") syncRange(e.target);
  });
  setInterval(syncAllRanges, 300);
  syncAllRanges();

  const observer = new MutationObserver(evaluate);
  panels.forEach((p) => observer.observe(p.el, { attributes: true, attributeFilter: ["class", "style"] }));
  if (hiresCheck) hiresCheck.addEventListener("change", evaluate);
  if (mq.addEventListener) mq.addEventListener("change", evaluate);
  else if (mq.addListener) mq.addListener(evaluate);
  evaluate();
})();
