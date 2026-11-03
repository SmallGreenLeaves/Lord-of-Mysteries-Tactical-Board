(function () {
  'use strict';

  window.GM = window.GM || {};
  var GM = window.GM;
  var U = GM.util;

  function q(sel) { return document.querySelector(sel); }

  function stopPlayback() {
    if (GM.state.ui.playing) {
      clearInterval(GM.state.ui.playing);
      GM.state.ui.playing = null;
    }
  }

  function planList() {
    return GM.plansForMap();
  }

  function renderBar() {
    var planSelect = q('#planSelect');
    var phasesHost = q('#phaseChips');
    if (!planSelect || !phasesHost) return;

    var plan = GM.ensureActivePlan();
    var list = planList();

    planSelect.innerHTML = list.map(function (p) {
      return '<option value="' + U.esc(p.id) + '"' + (p.id === (plan && plan.id) ? ' selected' : '') + '>' +
        U.esc(p.name) + '（' + p.phases.length + ' 阶段）</option>';
    }).join('');

    var phase = GM.activePhase();
    var idx = GM.phaseIndex();
    phasesHost.innerHTML = plan.phases.map(function (p, i) {
      return '<button type="button" class="phase-chip' + (p.id === (plan.activePhaseId || '') ? ' active' : '') + '" data-phase-id="' + U.esc(p.id) + '" title="切换到该阶段">' +
        '<span class="chip-index">' + String(i + 1).padStart(2, '0') + '</span>' + U.esc(p.name) +
        '</button>';
    }).join('');

    var btnRename = q('#btnPhaseRename');
    var btnDeletePhase = q('#btnPhaseDelete');
    var btnPlanRename = q('#btnPlanRename');
    var btnPlanDelete = q('#btnPlanDelete');
    if (btnRename) btnRename.disabled = !plan;
    if (btnDeletePhase) btnDeletePhase.disabled = !plan || plan.phases.length <= 1;
    if (btnPlanRename) btnPlanRename.disabled = !plan;
    if (btnPlanDelete) btnPlanDelete.disabled = !plan || list.length <= 1;

    var btnPlay = q('#btnPlay');
    if (btnPlay) btnPlay.textContent = GM.state.ui.playing ? '■ 停止' : '▶ 播放';

    var btnDiff = q('#btnDiff');
    if (btnDiff) {
      btnDiff.classList.toggle('gold', GM.state.ui.diff);
      btnDiff.disabled = idx <= 0;
    }

    var diffSummary = q('#diffSummary');
    if (diffSummary) {
      if (!GM.state.ui.diff) {
        diffSummary.textContent = idx > 0 ? '可对比上阶段' : '';
      } else {
        var stats = GM.board && GM.board.diffStats ? GM.board.diffStats() : null;
        if (!stats) {
          diffSummary.textContent = '当前为第一阶段，无可对比阶段';
        } else {
          diffSummary.innerHTML = '位移 <b>' + stats.moved + '</b> · 新增 <b>' + stats.added + '</b> · 消失 <b style="color:var(--crimson-2)">' + stats.removed + '</b>';
        }
      }
    }
  }

  function switchPlan(planId) {
    var project = GM.state.project;
    var plan = project.plans.filter(function (p) { return p.id === planId; })[0];
    if (!plan) return;
    project.activePlanId = plan.id;
    GM.ensureActivePlan();
    GM.state.ui.selected = null;
    GM.refresh('切换方案');
    GM.bus.emit('selection');
  }

  function switchPhase(phaseId) {
    var plan = GM.activePlan();
    if (!plan) return;
    if (!plan.phases.some(function (p) { return p.id === phaseId; })) return;
    plan.activePhaseId = phaseId;
    GM.state.ui.selected = null;
    GM.refresh('切换阶段');
    GM.bus.emit('selection');
  }

  function addPlan() {
    var mapId = GM.state.project.mapId;
    var index = planList().length + 1;
    GM.ui.promptText('新建方案', '方案名称', '方案 ' + index).then(function (name) {
      if (name == null) return;
      var plan = GM.newPlan(mapId, name.trim() || ('方案 ' + index));
      GM.state.project.plans.push(plan);
      GM.state.project.activePlanId = plan.id;
      GM.refresh('新建方案');
      GM.ui.toast('已新建空方案「' + plan.name + '」', 'success');
    });
  }

  function copyPlan() {
    var source = GM.activePlan();
    if (!source) return;
    var clone = U.clone(source);
    clone.id = U.uid('plan');
    clone.name = source.name + ' 副本';

    /* 阶段内保留标记 id，复制后仍可对比位移；阶段 id 与绘图对象 id 重新生成 */
    clone.phases.forEach(function (phase) {
      phase.id = U.uid('phase');
      phase.shapes = phase.shapes.map(function (s) { var c = U.clone(s); c.id = U.uid('shape'); return c; });
    });
    clone.activePhaseId = clone.phases[0].id;
    GM.ensurePlanMeta(clone);
    GM.state.project.plans.push(clone);
    GM.state.project.activePlanId = clone.id;
    GM.refresh('复制方案');
    GM.ui.toast('已复制为「' + clone.name + '」', 'success');
  }

  function renamePlan() {
    var plan = GM.activePlan();
    if (!plan) return;
    GM.ui.promptText('重命名方案', '方案名称', plan.name).then(function (name) {
      if (name == null || !name.trim() || name.trim() === plan.name) return;
      plan.name = name.trim();
      GM.commit('重命名方案');
    });
  }

  function deletePlan() {
    var plan = GM.activePlan();
    if (!plan || planList().length <= 1) return;
    GM.ui.confirm('删除方案', '确定删除方案「' + plan.name + '」？其中的 ' + plan.phases.length + ' 个阶段快照都会删除。', '删除').then(function (ok) {
      if (!ok) return;
      var project = GM.state.project;
      project.plans = project.plans.filter(function (p) { return p.id !== plan.id; });
      project.activePlanId = null;
      stopPlayback();
      GM.ensureActivePlan();
      GM.state.ui.selected = null;
      GM.commit('删除方案');
      GM.bus.emit('selection');
    });
  }

  function addPhase() {
    var plan = GM.activePlan();
    if (!plan) return;
    var current = GM.activePhase();
    var index = plan.phases.length + 1;

    GM.ui.promptText('新增阶段', '阶段名称', '阶段 ' + index).then(function (name) {
      if (name == null) return;
      var phase = GM.newPhase(name.trim() || ('阶段 ' + index));
      if (current) {
        phase.markers = U.clone(current.markers);
        phase.shapes = U.clone(current.shapes);
      }
      plan.phases.push(phase);
      plan.activePhaseId = phase.id;
      GM.state.ui.selected = null;
      GM.commit('新增阶段');
      GM.bus.emit('selection');
      GM.ui.toast('已新增阶段「' + phase.name + '」，布置继承自上一阶段', 'success');
    });
  }

  function renamePhase() {
    var plan = GM.activePlan();
    var phase = GM.activePhase();
    if (!plan || !phase) return;
    GM.ui.promptText('重命名阶段', '阶段名称', phase.name).then(function (name) {
      if (name == null || !name.trim() || name.trim() === phase.name) return;
      phase.name = name.trim();
      GM.commit('重命名阶段');
    });
  }

  function deletePhase() {
    var plan = GM.activePlan();
    var phase = GM.activePhase();
    if (!plan || !phase || plan.phases.length <= 1) return;
    GM.ui.confirm('删除阶段', '确定删除阶段「' + phase.name + '」及其中的布置？', '删除').then(function (ok) {
      if (!ok) return;
      var idx = plan.phases.indexOf(phase);
      plan.phases.splice(idx, 1);
      var next = plan.phases[Math.max(0, idx - 1)];
      plan.activePhaseId = next.id;
      GM.state.ui.selected = null;
      stopPlayback();
      GM.commit('删除阶段');
      GM.bus.emit('selection');
    });
  }

  function toggleDiff() {
    var idx = GM.phaseIndex();
    if (idx <= 0) {
      GM.ui.toast('当前是第一个阶段，没有上一阶段可对比', 'error');
      return;
    }
    GM.state.ui.diff = !GM.state.ui.diff;
    GM.refresh('切换差异对比');
  }

  function togglePlay() {
    if (GM.state.ui.playing) {
      stopPlayback();
      renderBar();
      return;
    }
    var plan = GM.activePlan();
    if (!plan || plan.phases.length < 2) {
      GM.ui.toast('至少需要两个阶段才能播放', 'error');
      return;
    }

    var idx = GM.phaseIndex();
    if (idx >= plan.phases.length - 1) idx = -1;
    var nextIndex = idx + 1;

    GM.state.ui.playing = setInterval(function () {
      var active = GM.activePlan();
      if (!active) { stopPlayback(); renderBar(); return; }
      if (nextIndex >= active.phases.length) {
        stopPlayback();
        renderBar();
        return;
      }
      active.activePhaseId = active.phases[nextIndex].id;
      nextIndex++;
      GM.state.ui.selected = null;
      GM.refresh('播放阶段');
      GM.bus.emit('selection');
    }, 1400);

    renderBar();
  }

  function bind() {
    var planSelect = q('#planSelect');
    if (!planSelect) return;

    planSelect.addEventListener('change', function () {
      stopPlayback();
      switchPlan(planSelect.value);
    });

    q('#btnPlanNew').addEventListener('click', addPlan);
    q('#btnPlanCopy').addEventListener('click', copyPlan);
    q('#btnPlanRename').addEventListener('click', renamePlan);
    q('#btnPlanDelete').addEventListener('click', deletePlan);
    q('#btnPhaseAdd').addEventListener('click', addPhase);
    q('#btnPhaseRename').addEventListener('click', renamePhase);
    q('#btnPhaseDelete').addEventListener('click', deletePhase);
    q('#btnDiff').addEventListener('click', toggleDiff);
    q('#btnPlay').addEventListener('click', togglePlay);

    q('#phaseChips').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-phase-id]');
      if (!chip) return;
      stopPlayback();
      switchPhase(chip.getAttribute('data-phase-id'));
    });
  }

  GM.plans = {
    init: function () {
      bind();
      GM.bus.on('change', function (payload) {
        if (payload && (payload.label === 'undo' || payload.label === 'redo' || payload.label === 'import')) {
          stopPlayback();
        }
        renderBar();
      });
      GM.bus.on('map:changed', function () {
        stopPlayback();
        GM.state.ui.diff = false;
        renderBar();
      });
      renderBar();
    },
    render: renderBar,
    stopPlayback: stopPlayback
  };
})();
