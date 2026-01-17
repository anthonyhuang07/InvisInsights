(function (window, document) {
  if (window.invisinsights) return;

  var config = {
    endpoint: 'https://invisinsights.tech/collect',
    idleThresholdMs: 3000,
    hoverThresholdMs: 800,
    scrollReversalWindowMs: 600,
    rereadWindowMs: 15000,
    rageClickWindowMs: 800,
    rageClickRadiusPx: 24,
    ctaProximityPx: 120,
    projectKey: null
  };

  function getProjectKey() {
    var s = document.currentScript;
    return (
      (s && s.getAttribute('data-project-key')) ||
      window.invisinsightsProjectKey ||
      null
    );
  }

  function now() {
    return Date.now();
  }

  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      'sess_' + Math.random().toString(36).slice(2);
  }

  var state = {
    sessionId: sessionStorage.getItem('ifai_sid') || uuid(),
    pageStartTs: now(),
    lastActiveTs: now(),
    idleStartTs: 0,
    idleDurations: [],
    scrollReversalCount: 0,
    rereadCount: 0,
    rageClickCount: 0,
    disabledClickCount: 0,
    nonInteractiveClickCount: 0,
    confidenceClickCount: 0,
    goalCompleted: false,
    goalType: null,
    lastInteraction: null,
    lastInteractionTs: 0,
    recentClicks: [],
    sectionVisits: new Map(),
    sentFinal: false,
    projectKey: getProjectKey()
  };

  sessionStorage.setItem('ifai_sid', state.sessionId);

  function isDisabled(el) {
    return el && (el.disabled || el.getAttribute('aria-disabled') === 'true');
  }

  function isInteractive(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName.toLowerCase();
    return (
      ['button', 'a', 'input', 'select', 'textarea'].includes(tag) ||
      el.getAttribute('role') === 'button' ||
      typeof el.onclick === 'function'
    );
  }

  function isCTA(el) {
    return el && (
      el.matches('button, a[href], input[type=submit], input[type=button]') ||
      el.hasAttribute('data-cta')
    );
  }

  function markActivity(el) {
    var ts = now();
    if (state.idleStartTs) {
      state.idleDurations.push(ts - state.idleStartTs);
      state.idleStartTs = 0;
    }
    state.lastActiveTs = ts;
    if (el) {
      state.lastInteraction = {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null
      };
      state.lastInteractionTs = ts;
    }
  }

  function onIdleCheck() {
    var ts = now();
    if (!state.idleStartTs && ts - state.lastActiveTs >= config.idleThresholdMs) {
      state.idleStartTs = ts;
    }
  }

  function onScroll() {
    var y = window.scrollY || 0;
    var ts = now();

    var sectionSize = Math.max(window.innerHeight * 0.8, 1);
    var sectionIndex = Math.floor(y / sectionSize);
    var lastVisit = state.sectionVisits.get(sectionIndex);

    if (lastVisit && ts - lastVisit <= config.rereadWindowMs) {
      state.rereadCount += 1;
    }

    state.sectionVisits.set(sectionIndex, ts);
    markActivity(null);
  }

  function onClick(e) {
    var ts = now();
    var el = e.target;

    if (isDisabled(el)) state.disabledClickCount += 1;
    else if (!isInteractive(el)) state.nonInteractiveClickCount += 1;

    state.recentClicks.push({ ts: ts });
    state.recentClicks = state.recentClicks.filter(
      function (c) { return ts - c.ts <= config.rageClickWindowMs; }
    );

    if (state.recentClicks.length >= 3) {
      state.rageClickCount += 1;
    }

    // Confidence click: CTA click without hesitation
    if (
      isCTA(el) &&
      ts - state.lastActiveTs < 800 &&
      !state.idleStartTs
    ) {
      state.confidenceClickCount += 1;
    }

    // Goal completion
    if (el && el.hasAttribute('data-ifai-goal')) {
      state.goalCompleted = true;
      state.goalType = el.getAttribute('data-ifai-goal');
    }

    markActivity(el);
  }

  function buildPayload(reason) {
    var ts = now();
    var timeOnPage = ts - state.pageStartTs;

    var fastPath =
      state.goalCompleted &&
      timeOnPage < 15000 &&
      state.idleDurations.length === 0 &&
      state.rereadCount === 0;

    return {
      project_id: state.projectKey,
      session_id: state.sessionId,
      page_path: location.pathname,
      page_query: location.search || '',
      timestamp_ms: ts,
      time_on_page_ms: timeOnPage,
      idle_hesitation_count: state.idleDurations.length,
      avg_hesitation_time_ms:
        state.idleDurations.length
          ? Math.round(state.idleDurations.reduce((a, b) => a + b, 0) / state.idleDurations.length)
          : 0,
      scroll_reversal_count: state.scrollReversalCount,
      reread_section_count: state.rereadCount,
      rage_click_count: state.rageClickCount,
      disabled_click_count: state.disabledClickCount,
      noninteractive_click_count: state.nonInteractiveClickCount,
      confidence_click_count: state.confidenceClickCount,
      goal_completed: state.goalCompleted,
      goal_type: state.goalType,
      fast_path_completion: fastPath,
      last_interaction: state.lastInteraction,
      session_end_reason: reason || 'unknown'
    };
  }

  function sendPayload(reason) {
    if (state.sentFinal) return;
    state.sentFinal = true;

    if (!state.projectKey) return;

    fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Invis-Project-Key': state.projectKey
      },
      body: JSON.stringify(buildPayload(reason)),
      keepalive: true
    });
  }

  function init() {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', function () {
      sendPayload('beforeunload');
    });
    window.addEventListener('pagehide', function () {
      sendPayload('pagehide');
    });
    setInterval(onIdleCheck, 1000);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

  window.invisinsights = {
    flush: function () {
      sendPayload('manual');
    }
  };

})(window, document);