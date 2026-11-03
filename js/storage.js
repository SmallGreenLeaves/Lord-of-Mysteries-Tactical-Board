(function () {
  'use strict';

  window.GM = window.GM || {};
  var GM = window.GM;
  var U = GM.util;

  var KEY = 'gm.tactical.board.v1';

  function storageAvailable() {
    try {
      var probe = '__gm_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return true;
    } catch (err) {
      return false;
    }
  }

  function emitSave(status, detail) {
    GM.state.ui.saveStatus = status;
    GM.bus.emit('save', { status: status, detail: detail || '' });
  }

  function reasonOf(err) {
    var name = (err && err.name) || '';
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || (err && err.code === 22)) {
      return '本地存储空间不足（QuotaExceededError）：请清理浏览器站点数据或减少沙盘标记后再试';
    }
    return (err && err.message) ? String(err.message) : '未知错误';
  }

  function saveNow() {
    if (!GM.state.project) return;
    if (!storageAvailable()) {
      emitSave('unavailable', '浏览器禁用了 localStorage（无痕模式 / 站点设置），改动只保存在当前页面内');
      return;
    }
    try {
      window.localStorage.setItem(KEY, GM.serialize());
      emitSave('saved');
    } catch (err) {
      console.error('[GM] 本地保存失败:', err);
      emitSave('error', reasonOf(err));
    }
  }

  /* 自动保存：所有 GM.commit / GM.refresh 都会触发，450ms 防抖 */
  GM.saveSoon = U.debounce(saveNow, 450);

  function init() {
    var raw = null;
    var available = storageAvailable();

    if (available) {
      try {
        raw = window.localStorage.getItem(KEY);
      } catch (err) {
        raw = null;
      }
    }

    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        GM.normalizeProject(parsed);
        GM.resetHistory();
        emitSave('restored');
        return;
      } catch (err) {
        console.warn('[GM] 本地存档损坏，已新建工程：', err);
      }
    }

    GM.state.project = GM.createProject();
    GM.resetHistory();
    emitSave(available ? 'new' : 'unavailable');
  }

  function exportProject() {
    if (!GM.state.project) return;
    var out = U.clone(GM.state.project);
    /* 显式双份：live = 当前实时编成（等价 project.teams）；presets = 历史快照 */
    out.live = U.clone(GM.state.project.teams || []);
    out.presets = U.clone(GM.state.project.presets || []);
    out.liveNote = '当前实时编成（teams 的同一份数据，便于区分 live / preset）';
    out.exportedAt = new Date().toISOString();
    out.app = '诡秘之主 · GvG 战术板';
    var filename = '诡秘战术板_' + (out.name || '工程') + '_' + U.dateStamp() + '.json';
    U.download(filename, JSON.stringify(out, null, 2));
    GM.ui.toast('已导出 ' + filename + '（含实时编成 live 与预设 presets）', 'success');
  }

  function importProject(file, callback) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var parsed = null;
      try {
        parsed = JSON.parse(String(e.target.result || ''));
        GM.normalizeProject(parsed);
      } catch (err) {
        if (callback) callback(err, null);
        return;
      }

      GM.resetHistory();
      GM.state.ui.diff = false;
      GM.state.ui.selected = null;
      emitSave('pending');
      GM.bus.emit('change', { label: 'import' });
      GM.bus.emit('imported', { project: GM.state.project });
      saveNow();
      if (callback) callback(null, GM.state.project);
    };
    reader.onerror = function () {
      if (callback) callback(new Error('文件读取失败'), null);
    };
    reader.readAsText(file, 'utf-8');
  }

  GM.storage = {
    KEY: KEY,
    init: init,
    available: storageAvailable,
    saveNow: saveNow,
    exportProject: exportProject,
    importProject: importProject
  };
})();
