/* 诡秘之主 · GvG 战术板 —— 推演引擎
 *
 * 纯函数计算 + 结果面板。capture / escort 的目标、结算、跟随、送达、劣势阈值等
 * 为官方规则原文（唯一来源是 data/maps.js 的 md.scoring / md.commands）；
 * escort 的定时周期与分值、圈内击杀单价、siege 系数为【假设值，可调】：
 *   - 界面输入可实时修改，修改立即重算；
 *   - 结果不写入存档；只有点击「保存推演参数」才会写入 plan.sim。
 *
 * 三种地图模式的参数含义与默认值见 README_AI.md「推演引擎」章节。
 */
(function () {
  'use strict';

  window.GM = window.GM || {};
  var GM = window.GM;
  var U = GM.util;

  function q(sel) { return document.querySelector(sel); }

  /* ============================ 可调参数默认值（假设值） ============================ */

  var DEFAULTS = {
    /* 四方战（capture）的参数不在这里硬编码：全部从 data/maps.js 的 md.scoring 读取，
       推演面板的输入只是对本次推演的覆盖值。 */
    /* 护送速度按 unit/s 给：星墓高原 1 unit = 1 人宽（曾按 1 unit = 1 图像 px 定为 12 / 4 / 8），
       地图改用 unit 基准后坐标缩到 1/3，速度同步取 1/3，推演到达时间与原来等价。仅 escort 使用。 */
    escort: {
      baseSpeed: 4,
      perEscorterSpeed: 1.33,
      retreatSpeed: 2.67
    },
    siege: {
      perMemberPerSecond: 0.5,
      target: 100,
      duration: 120
    }
  };

  var state = {
    mode: null,
    capture: null,
    escort: null,
    siege: null
  };

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function round2(v) { return Math.round(v * 100) / 100; }

  function factions() {
    var project = GM.state.project;
    return (project && project.factions) || window.GM_DATA.defaultFactions;
  }

  function factionById(id) {
    var list = factions();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return { id: id, name: id || '无归属', color: '#8a919f' };
  }

  function primaryFactions(md) {
    return factions().slice(0, (md && md.factionCount) || 4);
  }

  /* ============================ 数据准备 ============================ */

  function findObjective(md, id) {
    var hit = null;
    (md.objectives || []).forEach(function (o) { if (o.id === id) hit = o; });
    return hit;
  }

  function findCaptureCircle(md) {
    var hit = null;
    (md.objectives || []).forEach(function (o) { if (o.type === 'capture-circle') hit = o; });
    return hit;
  }

  function emptyCounts(md) {
    var counts = {};
    primaryFactions(md).forEach(function (f) { counts[f.id] = 0; });
    return counts;
  }

  function platformObjective(md) {
    var hit = null;
    (md.objectives || []).forEach(function (o) { if (o.type === 'platform') hit = o; });
    return hit;
  }

  function readCircleCounts(md, radiusOverride) {
    var circle = findCaptureCircle(md);
    if (!circle || !GM.board || !GM.board.circleCounts) return emptyCounts(md);
    /* 圆心取方案里可拖动的 escort.circle；默认判定半径用 captureRadius（高台边长的 1/4），
       跟随判定可传入 followRadius（20 米 = 20 unit，假设 1 unit = 1 米） */
    var pt = GM.captureCirclePoint ? GM.captureCirclePoint(md, GM.activePlan()) : { x: circle.x, y: circle.y };
    var raw = GM.board.circleCounts({
      x: pt.x,
      y: pt.y,
      radius: radiusOverride || circle.captureRadius || circle.radius,
      level: circle.level || 'upper'
    });
    var counts = emptyCounts(md);
    primaryFactions(md).forEach(function (f) {
      counts[f.id] = (raw.byFaction && raw.byFaction[f.id]) || 0;
    });
    return counts;
  }

  function readPlatformCounts(md) {
    var platform = platformObjective(md);
    if (!platform || !GM.board || !GM.board.circleCounts) return emptyCounts(md);
    var radius = (md.siege && md.siege.platform && md.siege.platform.radius) || 105;
    var raw = GM.board.circleCounts({ x: platform.x, y: platform.y, radius: radius, level: platform.level || 'ground' });
    var counts = emptyCounts(md);
    primaryFactions(md).forEach(function (f) {
      counts[f.id] = (raw.byFaction && raw.byFaction[f.id]) || 0;
    });
    return counts;
  }

  /* ============================ 默认参数 ============================ */

  function pickNumber(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  /* 四方战规则参数：唯一来源是 data/maps.js 的 md.scoring */
  function captureConfig(md) {
    var sc = (md && md.scoring) || {};
    return {
      duration: Math.max(1, pickNumber(sc.durationSeconds, 1)),
      target: Math.max(1, pickNumber(sc.targetScore, 1)),
      first: Math.max(0, pickNumber(sc.firstCapturePoints, 0)),
      bigTick: Math.max(1, pickNumber(sc.bigTickSeconds, 1)),
      bigPts: Math.max(0, pickNumber(sc.bigPointsPerGuard, 0)),
      instantRespawn: sc.instantRespawn !== false,
      high: sc.highValue || { timesSeconds: [], announceLeadSeconds: 0, windowSeconds: 60, groups: [] }
    };
  }

  /* 星墓高原（escort）规则参数：唯一来源是 data/maps.js 的 md.scoring */
  function escortConfig(md) {
    var sc = (md && md.scoring) || {};
    return {
      target: Math.max(1, pickNumber(sc.targetScore, 15000)),
      duration: Math.max(60, pickNumber(sc.durationSeconds, 900)),
      delivery: Math.max(0, pickNumber(sc.deliveryPoints, 1200)),
      radius: Math.max(0, pickNumber(sc.followRadius, 20)),
      minCount: Math.max(1, pickNumber(sc.followMinCount, 5)),
      tick: Math.max(1, pickNumber(sc.tickSeconds, 30)),
      nearPts: Math.max(0, pickNumber(sc.nearPoints, 30)),
      followerPts: Math.max(0, pickNumber(sc.followerPoints, 100)),
      killPts: Math.max(0, pickNumber(sc.killInsideCircle, 5)),
      killEnabled: sc.killEnabled !== false,
      gap: Math.max(0, pickNumber(sc.underdogGap, 3000)),
      snareEvery: Math.max(1, pickNumber(sc.snareIntervalSeconds, 300)),
      teleEvery: Math.max(1, pickNumber(sc.teleportIntervalSeconds, 480)),
      teleActivators: Math.max(1, pickNumber(sc.teleportActivators, 1)),
      cycle: Math.max(1, pickNumber(sc.escortCycleSeconds, 60))
    };
  }

  function defaultCapture(md, plan) {
    var cfg = captureConfig(md);
    var owners = {};
    (md.objectives || []).forEach(function (o) {
      var owned = plan && plan.scoring && plan.scoring.ownership ? plan.scoring.ownership[o.id] : null;
      owners[o.id] = owned || null;
    });
    var resources = {}, morale = {}, kills = {}, rating = {}, cooldowns = {};
    var highGroups = {};
    (((md.scoring || {}).highValue || {}).groups || []).forEach(function (g) {
      highGroups[g.id] = Math.max(1, pickNumber(g.multiplier, 1));
    });
    primaryFactions(md).forEach(function (f) {
      resources[f.id] = 0;
      morale[f.id] = 0;
      kills[f.id] = 0;
      rating[f.id] = 0;
      cooldowns[f.id] = {};
    });
    return {
      durationSeconds: cfg.duration,
      targetScore: cfg.target,
      firstCapturePoints: cfg.first,
      bigTickSeconds: cfg.bigTick,
      bigPointsPerGuard: cfg.bigPts,
      instantRespawn: cfg.instantRespawn,
      /* 资源获取速率不在官方规则里，留作可输入（点/分钟，假设值） */
      resourceRatePerMinute: 0,
      clubFactionId: (primaryFactions(md)[0] || { id: 'A' }).id,
      resources: resources,
      morale: morale,
      kills: kills,
      rating: rating,
      cooldowns: cooldowns,
      highGroups: highGroups,
      phases: [{ id: U.uid('simphase'), name: '阶段 1', seconds: cfg.duration, owners: owners }]
    };
  }

  function defaultEscort(md, plan) {
    var cfg = escortConfig(md);
    var counts = readCircleCounts(md);
    var followCounts = readCircleCounts(md, cfg.radius);
    var carrier = null;
    var best = 0;
    primaryFactions(md).forEach(function (f) {
      if ((followCounts[f.id] || 0) > best) { best = followCounts[f.id]; carrier = f.id; }
    });
    if (!carrier) {
      primaryFactions(md).forEach(function (f) {
        if ((counts[f.id] || 0) > best) { best = counts[f.id]; carrier = f.id; }
      });
    }
    if (!carrier) carrier = (primaryFactions(md)[0] || { id: 'A' }).id;

    var dests = (md.escort && md.escort.returnTargets) || [];
    var destinationId = dests[0] || ((md.objectives || [])[0] || {}).id;
    if (plan && plan.escort && plan.escort.destinationId) destinationId = plan.escort.destinationId;

    var kills = {}, mech = {};
    primaryFactions(md).forEach(function (f) {
      kills[f.id] = 0;
      mech[f.id] = { snareTimes: [], teleportTimes: [] };
    });

    return {
      baseSpeed: DEFAULTS.escort.baseSpeed,
      perEscorterSpeed: DEFAULTS.escort.perEscorterSpeed,
      retreatSpeed: DEFAULTS.escort.retreatSpeed,
      targetScore: cfg.target,
      durationSeconds: cfg.duration,
      deliveryPoints: cfg.delivery,
      followRadius: cfg.radius,
      followMinCount: cfg.minCount,
      tickSeconds: cfg.tick,
      nearPoints: cfg.nearPts,
      followerPoints: cfg.followerPts,
      killInsideCircle: cfg.killPts,
      killEnabled: cfg.killEnabled,
      underdogGap: cfg.gap,
      snareIntervalSeconds: cfg.snareEvery,
      teleportIntervalSeconds: cfg.teleEvery,
      teleportActivators: cfg.teleActivators,
      escortCycleSeconds: cfg.cycle,
      counts: counts,
      followCounts: followCounts,
      carrier: carrier,
      destinationId: destinationId,
      destinationFactionId: null,
      kills: kills,
      mech: mech,
      mechClockSeconds: 0
    };
  }

  function defaultSiege(md) {
    return {
      perMemberPerSecond: DEFAULTS.siege.perMemberPerSecond,
      target: (md.siege && md.siege.platform && md.siege.platform.scoreTarget) || DEFAULTS.siege.target,
      duration: DEFAULTS.siege.duration,
      members: readPlatformCounts(md)
    };
  }

  function normalizeCounts(md, raw) {
    var counts = emptyCounts(md);
    primaryFactions(md).forEach(function (f) {
      var v = raw && raw[f.id];
      counts[f.id] = Math.max(0, Math.round(Number(v) || 0));
    });
    return counts;
  }

  /* ============================ 状态装载 ============================ */

  function loadState(md, plan) {
    if (!md) return;
    state.mode = md.mode;
    var saved = plan && plan.sim ? plan.sim[md.mode] : null;

    if (md.mode === 'capture') {
      var c = defaultCapture(md, plan);
      if (saved) {
        c.durationSeconds = Math.max(1, pickNumber(saved.durationSeconds, c.durationSeconds));
        c.targetScore = Math.max(1, pickNumber(saved.targetScore, c.targetScore));
        c.firstCapturePoints = Math.max(0, pickNumber(saved.firstCapturePoints, c.firstCapturePoints));
        /* 旧版存档（含 5 秒小结算字段）统一迁移为 60 秒单结算，不再沿用旧的 30 秒周期 */
        var legacySmall = saved.smallTickSeconds != null || saved.smallPointsPerGuard != null;
        c.bigTickSeconds = legacySmall ? c.bigTickSeconds : Math.max(1, pickNumber(saved.bigTickSeconds, c.bigTickSeconds));
        c.bigPointsPerGuard = Math.max(0, pickNumber(saved.bigPointsPerGuard, c.bigPointsPerGuard));
        if (typeof saved.instantRespawn === 'boolean') c.instantRespawn = saved.instantRespawn;
        c.resourceRatePerMinute = Math.max(0, pickNumber(saved.resourceRatePerMinute, c.resourceRatePerMinute));
        if (saved.clubFactionId) c.clubFactionId = saved.clubFactionId;
        ['resources', 'morale', 'kills', 'rating'].forEach(function (key) {
          if (!saved[key] || typeof saved[key] !== 'object') return;
          primaryFactions(md).forEach(function (f) {
            c[key][f.id] = Math.max(0, pickNumber(saved[key][f.id], c[key][f.id] || 0));
          });
        });
        if (saved.cooldowns && typeof saved.cooldowns === 'object') {
          primaryFactions(md).forEach(function (f) {
            var src = saved.cooldowns[f.id];
            if (!src || typeof src !== 'object') return;
            Object.keys(src).forEach(function (sid) {
              c.cooldowns[f.id][sid] = Math.max(0, pickNumber(src[sid], 0));
            });
          });
        }
        if (saved.highGroups && typeof saved.highGroups === 'object') {
          Object.keys(saved.highGroups).forEach(function (gid) {
            if (c.highGroups[gid] === undefined) return;
            c.highGroups[gid] = Math.max(1, pickNumber(saved.highGroups[gid], c.highGroups[gid]));
          });
        }
        if (Array.isArray(saved.phases) && saved.phases.length) {
          c.phases = saved.phases.map(function (p, i) {
            var owners = {};
            (md.objectives || []).forEach(function (o) {
              owners[o.id] = (p.owners && p.owners[o.id]) || null;
            });
            return {
              id: String(p.id || U.uid('simphase')),
              name: String(p.name || ('阶段 ' + (i + 1))),
              seconds: Math.max(0, Math.round(Number(p.seconds) || 0)),
              owners: owners
            };
          });
        }
      }
      state.capture = c;
    } else if (md.mode === 'escort') {
      var e = defaultEscort(md, plan);
      if (saved) {
        ['baseSpeed', 'perEscorterSpeed', 'retreatSpeed', 'targetScore', 'durationSeconds',
          'deliveryPoints', 'followRadius', 'followMinCount', 'tickSeconds', 'nearPoints',
          'followerPoints', 'killInsideCircle', 'underdogGap', 'snareIntervalSeconds',
          'teleportIntervalSeconds', 'teleportActivators', 'escortCycleSeconds', 'mechClockSeconds'].forEach(function (k) {
          var v = Number(saved[k]);
          if (isFinite(v)) e[k] = v;
        });
        e.killEnabled = saved.killEnabled !== false;
        e.carrier = saved.carrier || e.carrier;
        e.destinationId = saved.destinationId || e.destinationId;
        if (saved.counts) e.counts = normalizeCounts(md, saved.counts);
        if (saved.followCounts) e.followCounts = normalizeCounts(md, saved.followCounts);
        if (saved.kills && typeof saved.kills === 'object') {
          primaryFactions(md).forEach(function (f) {
            e.kills[f.id] = Math.max(0, pickNumber(saved.kills[f.id], 0));
          });
        }
        if (saved.mech && typeof saved.mech === 'object') {
          primaryFactions(md).forEach(function (f) {
            var src = saved.mech[f.id] || {};
            var sn = src.snareTimes, tp = src.teleportTimes;
            e.mech[f.id].snareTimes = Array.isArray(sn) ? sn.map(function (v) { return Math.max(0, pickNumber(v, 0)); }) : [];
            e.mech[f.id].teleportTimes = Array.isArray(tp) ? tp.map(function (v) { return Math.max(0, pickNumber(v, 0)); }) : [];
          });
        }
      }
      state.escort = e;
    } else if (md.mode === 'siege-capture') {
      var s = defaultSiege(md);
      if (saved) {
        s.perMemberPerSecond = Number(saved.perMemberPerSecond);
        if (!isFinite(s.perMemberPerSecond)) s.perMemberPerSecond = DEFAULTS.siege.perMemberPerSecond;
        s.target = Number(saved.target) || s.target;
        s.duration = Number(saved.duration) || s.duration;
        if (saved.members) s.members = normalizeCounts(md, saved.members);
      }
      state.siege = s;
    } else {
      state.capture = null;
      state.escort = null;
      state.siege = null;
    }
  }

  /* ============================ 计算：四方战（capture） ============================ */

  /* 官方规则计分（统一 60 秒一结算，不再有 5 秒小结算）：
     首占 +50；之后每 bigTick 秒（默认 60）每个已占领守卫 +bigPts（18）；
     若该结算点落在高倍窗口内，本次结算按事件倍率放大（72 / 108）；
     率先达到 target 分立即锁定胜局，否则按当前积分排位。
     所有数值来自 md.scoring，params 只是本次推演的覆盖值。 */
  function computeCapture(md, params) {
    var fs = primaryFactions(md);
    var cfg = captureConfig(md);
    var p = params || {};
    var objs = (md.objectives || []).map(function (o) {
      return { id: o.id, name: o.name };
    });

    var bigTick = Math.max(1, pickNumber(p.bigTickSeconds, cfg.bigTick));
    var bigPts = Math.max(0, pickNumber(p.bigPointsPerGuard, cfg.bigPts));
    var firstPts = Math.max(0, pickNumber(p.firstCapturePoints, cfg.first));
    var target = Math.max(1, pickNumber(p.targetScore, cfg.target));
    var duration = Math.max(1, pickNumber(p.durationSeconds, cfg.duration));
    var instantRespawn = typeof p.instantRespawn === 'boolean' ? p.instantRespawn : cfg.instantRespawn;

    var phases = (p.phases || []).map(function (ph) {
      return { seconds: Math.max(0, Math.round(Number(ph.seconds) || 0)), owners: ph.owners || {} };
    });
    var phaseTotal = 0;
    phases.forEach(function (ph) { phaseTotal += ph.seconds; });
    var simSeconds = Math.min(duration, phaseTotal || duration, 7200);

    var score = {};
    fs.forEach(function (f) { score[f.id] = 0; });

    var series = fs.map(function (f) {
      return { id: f.id, name: f.name, color: f.color, points: [{ t: 0, v: 0 }] };
    });

    function ownedCount(owners, fid) {
      var n = 0;
      objs.forEach(function (o) {
        if (owners[o.id] && owners[o.id] === fid) n++;
      });
      return n;
    }

    /* 每 bigTick 秒统一结算一次的稳态速率（不含高倍），用于达标 / 反超外推 */
    function steadyRateOf(owners) {
      var r = {};
      fs.forEach(function (f) {
        var n = ownedCount(owners, f.id);
        r[f.id] = n > 0 ? (bigPts / bigTick) : 0;
      });
      return r;
    }

    function highEventAt(t) {
      var windowSeconds = Math.max(0, pickNumber(high.windowSeconds, 0));
      for (var i = 0; i < highValue.length; i++) {
        var ev = highValue[i];
        if (t >= ev.atSecond && t < ev.atSecond + windowSeconds) return ev;
      }
      return null;
    }

    var captures = [];
    var capturedOnce = {};
    var prevOwners = {};
    objs.forEach(function (o) {
      var init = phases.length ? (phases[0].owners[o.id] || null) : null;
      prevOwners[o.id] = init;
      /* 开局已归属的守卫视为此前已被占领，不补发首占 +50 */
      capturedOnce[o.id] = !!init;
    });

    /* 高倍点位组：每个时间点按序号轮转抽中一组（固定轮转，可复现），
       只有该组内、且当前已归属的守卫享受高倍；组外守卫仍按基础 18 分。 */
    var high = cfg.high || {};
    var highGroups = high.groups || [];
    var highTimes = high.timesSeconds || [];
    var mulOverride = p.highGroups || {};

    function guardNameOf(id) {
      var g = null;
      objs.forEach(function (o) { if (o.id === id) g = o; });
      return g ? g.name : id;
    }

    var highValue = highTimes.map(function (at, i) {
      var grp = highGroups.length ? highGroups[i % highGroups.length] : null;
      var mul = grp ? Math.max(1, pickNumber(mulOverride[grp.id], pickNumber(grp.multiplier, 1))) : 1;
      var ids = grp ? (grp.guards || []).slice() : [];
      return {
        atSecond: pickNumber(at, 0),
        announceAt: Math.max(0, pickNumber(at, 0) - pickNumber(high.announceLeadSeconds, 0)),
        groupId: grp ? grp.id : null,
        groupName: grp ? (grp.name || grp.id) : '未配置',
        guardIds: ids,
        guardNames: ids.map(guardNameOf),
        multiplier: mul,
        pointsPerGuard: bigPts * mul,
        /* 结算时累计：组内已占领守卫数、该次高倍的额外得分；settled 表示该时间点是否真的进入模拟 */
        ownedCount: 0,
        extraPoints: 0,
        settled: false
      };
    });

    var targetAt = {};
    var leadChanges = [];
    var leader = null;
    var winner = null;
    var lockedAt = null;
    var t = 0;
    var sample = Math.max(1, Math.ceil(simSeconds / 300));
    var breakLoop = false;

    phases.forEach(function (ph, phaseIndex) {
      if (breakLoop) return;
      /* 阶段起点即归属切换：最后一击夺权 → 守卫立即重生并归属夺权方（推演只记事件） */
      if (phaseIndex > 0) {
        objs.forEach(function (o) {
          var next = ph.owners[o.id] || null;
          var prev = prevOwners[o.id] || null;
          if (next === prev) return;
          var first = false;
          if (next && !capturedOnce[o.id]) {
            capturedOnce[o.id] = true;
            first = true;
            if (score[next] !== undefined) score[next] += firstPts;
          }
          captures.push({
            t: t,
            guardId: o.id,
            guardName: o.name,
            from: prev,
            to: next,
            first: first,
            points: first ? firstPts : 0,
            respawn: !!instantRespawn
          });
          prevOwners[o.id] = next;
        });
      }

      var secs = Math.min(ph.seconds, Math.max(0, simSeconds - t));
      for (var s = 0; s < secs; s++) {
        var owners = ph.owners;
        /* 唯一结算路径：每 bigTick 秒（默认 60）结算一次 */
        var bigHit = (t + 1) % bigTick === 0;
        var hv = bigHit ? highEventAt(t + 1) : null;

        if (bigHit) {
          var groupOwned = 0;
          fs.forEach(function (f) {
            var n = ownedCount(owners, f.id);
            var bonusN = 0;
            if (hv) {
              objs.forEach(function (o) {
                if (owners[o.id] === f.id && hv.guardIds.indexOf(o.id) >= 0) bonusN++;
              });
            }
            groupOwned += bonusN;
            score[f.id] += bigPts * n + (hv ? bigPts * (hv.multiplier - 1) * bonusN : 0);
          });
          if (hv) {
            hv.settled = true;
            hv.ownedCount += groupOwned;
            hv.extraPoints += bigPts * (hv.multiplier - 1) * groupOwned;
          }
        }

        t++;

        var reachWinner = null;
        fs.forEach(function (f) {
          if (!targetAt[f.id] && score[f.id] >= target) targetAt[f.id] = t;
          if (!reachWinner && score[f.id] >= target) reachWinner = f.id;
        });

        var current = null;
        var best = -1;
        fs.forEach(function (f) {
          if (score[f.id] > best) { best = score[f.id]; current = f.id; }
        });
        if (best <= 0) current = null;
        if (current !== leader) {
          if (current) leadChanges.push({ t: t, factionId: current });
          leader = current;
        }
        if (t % sample === 0 || t === simSeconds) {
          fs.forEach(function (f, i) {
            series[i].points.push({ t: t, v: round2(score[f.id]) });
          });
        }

        /* 率先达到 3000 分即刻锁定胜局，模拟在该秒停止 */
        if (reachWinner) {
          winner = reachWinner;
          lockedAt = t;
          breakLoop = true;
          break;
        }
        if (t >= simSeconds) breakLoop = true;
      }
    });

    var maxScore = 0;
    fs.forEach(function (f) { maxScore = Math.max(maxScore, score[f.id]); });

    /* 同分排序：积分 → 总击杀数 → 俱乐部非凡评分总和 */
    var kills = (params && params.kills) || {};
    var rating = (params && params.rating) || {};
    var ranking = fs.map(function (f) {
      return {
        factionId: f.id,
        name: f.name,
        color: f.color,
        score: round2(score[f.id]),
        kills: Math.max(0, pickNumber(kills[f.id], 0)),
        rating: Math.max(0, pickNumber(rating[f.id], 0))
      };
    }).sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (b.kills !== a.kills) return b.kills - a.kills;
      return b.rating - a.rating;
    });
    ranking.forEach(function (r, i) { r.rank = i + 1; });

    if (!winner && ranking.length) winner = ranking[0].factionId;
    var tieBreakWinner = !lockedAt && ranking.length > 1
      ? (ranking[0].score === ranking[1].score ? ranking[0] : null)
      : null;

    var lastOwners = phases.length ? phases[phases.length - 1].owners : {};
    var lastRate = steadyRateOf(lastOwners);

    var forecast = fs.map(function (f) {
      var rate = lastRate[f.id] || 0;
      var need = Math.max(0, target - score[f.id]);
      var reachIn = rate > 0 ? Math.ceil(need / rate) : null;
      var reachAt = reachIn === null ? null : t + reachIn;
      return {
        factionId: f.id,
        name: f.name,
        rate: round2(rate),
        reachIn: reachIn,
        reachAt: reachAt,
        text: rate > 0
          ? (need <= 0 ? '已达标' : '维持当前归属约 ' + reachIn + ' 秒后达标（第 ' + reachAt + ' 秒）')
          : '当前归属下不再增长'
      };
    });

    var overtakes = [];
    if (leader) {
      fs.forEach(function (f) {
        if (f.id === leader) return;
        var dr = (lastRate[f.id] || 0) - (lastRate[leader] || 0);
        if (dr <= 0) return;
        var gap = score[leader] - score[f.id];
        var dt = gap <= 0 ? 0 : Math.ceil(gap / dr);
        overtakes.push({
          factionId: f.id,
          name: f.name,
          inSeconds: dt,
          at: t + dt,
          text: dt <= 0 ? '已反超' : '约 ' + dt + ' 秒后反超'
        });
      });
    }

    return {
      mode: 'capture',
      target: target,
      totalSeconds: simSeconds,
      elapsedSeconds: t,
      scores: score,
      series: series,
      maxScore: maxScore,
      leader: leader,
      leadChanges: leadChanges,
      targetAt: targetAt,
      forecast: forecast,
      overtakes: overtakes,
      rates: lastRate,
      winner: winner,
      lockedAt: lockedAt,
      ranking: ranking,
      tieBreakWinner: tieBreakWinner,
      captures: captures,
      highValue: highValue,
      config: {
        bigTick: bigTick,
        bigPts: bigPts,
        firstPts: firstPts,
        instantRespawn: instantRespawn,
        announceLead: pickNumber((cfg.high || {}).announceLeadSeconds, 0)
      }
    };
  }

  /* ============================ 计算：星墓高原（escort） ============================ */

  function computeEscort(md, params) {
    var fs = primaryFactions(md);
    var circle = findCaptureCircle(md);
    var dest = findObjective(md, params.destinationId);
    var cfg = escortConfig(md);

    var counts = normalizeCounts(md, params.counts);
    /* 跟随判定圆（默认 20 unit = 20 米，假设 1 unit = 1 米）；旧参数无该字段时退回判定圈 */
    var followCounts = params.followCounts ? normalizeCounts(md, params.followCounts) : counts;
    var total = 0;
    var best = 0;
    var bestFid = null;
    var tie = false;
    fs.forEach(function (f) {
      var n = counts[f.id] || 0;
      total += n;
      if (n > best) { best = n; bestFid = f.id; tie = false; }
      else if (n === best && n > 0) { tie = true; }
    });
    var owner = best > 0 ? (tie ? null : bestFid) : null;

    var fBest = 0;
    var fBestFid = null;
    var fTie = false;
    fs.forEach(function (f) {
      var n = followCounts[f.id] || 0;
      if (n > fBest) { fBest = n; fBestFid = f.id; fTie = false; }
      else if (n === fBest && n > 0) { fTie = true; }
    });

    var tickSeconds = Math.max(1, Math.round(pickNumber(params.tickSeconds, cfg.tick)));
    var nearPoints = Math.max(0, pickNumber(params.nearPoints, cfg.nearPts));
    var followerPoints = Math.max(0, pickNumber(params.followerPoints, cfg.followerPts));
    var deliveryPoints = Math.max(0, pickNumber(params.deliveryPoints, cfg.delivery));
    var targetScore = Math.max(1, pickNumber(params.targetScore, cfg.target));
    var followMin = Math.max(1, Math.round(pickNumber(params.followMinCount, cfg.minCount)));
    var followRadius = Math.max(0, pickNumber(params.followRadius, cfg.radius));
    var killPts = params.killEnabled === false ? 0 : Math.max(0, pickNumber(params.killInsideCircle, cfg.killPts));
    var maxSeconds = Math.max(60, Math.round(pickNumber(params.durationSeconds, cfg.duration)));
    var underdogGap = Math.max(0, pickNumber(params.underdogGap, cfg.gap));
    var snareEvery = Math.max(1, Math.round(pickNumber(params.snareIntervalSeconds, cfg.snareEvery)));
    var teleEvery = Math.max(1, Math.round(pickNumber(params.teleportIntervalSeconds, cfg.teleEvery)));
    /* 单轮护送耗时（骑士送达后立即在中央重生，下一轮重新计时）：假设值，可输入 */
    var cycleSeconds = Math.max(1, Math.round(pickNumber(params.escortCycleSeconds, cfg.cycle)));

    /* 跟随：跟随圆内人数最多且 ≥ followMin；并列时按配置的 tieRule（默认 keep 保持原归属），
       无原归属则中立 */
    var tieRule = (md.scoring && md.scoring.tieRule) || 'keep';
    var follower = null;
    if (fBest >= followMin) {
      if (!fTie) follower = fBestFid;
      else if (tieRule === 'keep' && params.carrier && (followCounts[params.carrier] || 0) === fBest) follower = params.carrier;
    }

    var carrier = params.carrier || owner || (fs[0] && fs[0].id) || 'A';
    /* 起点 = 可拖动的占领圈圆心（方案 escort.circle，旧存档回退默认圆心） */
    var start = GM.captureCirclePoint ? GM.captureCirclePoint(md, GM.activePlan()) : null;
    var sx = start ? start.x : (circle ? circle.x : 264.33);
    var sy = start ? start.y : (circle ? circle.y : 168.67);
    var dx = dest ? dest.x : 261.67;
    var dy = dest ? dest.y : 113.33;
    var distance = Math.sqrt(Math.pow(dx - sx, 2) + Math.pow(dy - sy, 2));

    var baseSpeed = Math.max(0.1, Number(params.baseSpeed) || DEFAULTS.escort.baseSpeed);
    var perEscorter = Math.max(0, Number(params.perEscorterSpeed) || 0);
    var retreatSpeed = Math.max(0, Number(params.retreatSpeed) || 0);

    var escorts = followCounts[carrier] || 0;
    var opponent = 0;
    fs.forEach(function (f) { if (f.id !== carrier) opponent = Math.max(opponent, followCounts[f.id] || 0); });

    var speed = escorts > 0 ? baseSpeed + perEscorter * (escorts - 1) : 0;
    var progress = 0;
    var deliveredAt = null;
    var timeline = [{ t: 0, progress: 0, status: '出发' }];
    var status = '待命';

    for (var t = 0; t < maxSeconds; t++) {
      if (escorts <= 0) {
        status = '无人护送 · 停滞';
        timeline.push({ t: t + 1, progress: round2(progress), status: status });
        break;
      }
      if (opponent > escorts && progress > 0) {
        progress = Math.max(0, progress - retreatSpeed);
        status = '被敌方压制 · 回退';
      } else if (opponent > escorts) {
        status = '被敌方压制 · 停滞';
      } else {
        progress += speed;
        status = '护送推进';
      }
      if (progress >= distance) {
        progress = distance;
        deliveredAt = t + 1;
        timeline.push({ t: deliveredAt, progress: round2(progress), status: '抵达 ' + (dest ? dest.name : '目标广场') });
        break;
      }
      timeline.push({ t: t + 1, progress: round2(progress), status: status });
    }

    /* 循环护送：送达后骑士立刻在中央高台重生，按「单轮耗时」推进下一轮。
       轮时长取 max(单轮参数, 按速度估算的送达秒数)，避免参数小于实际路耗时。
       若无人护送 / 本轮无法抵达，则不产生送达。 */
    var canDeliver = deliveredAt !== null;
    var roundSeconds = canDeliver ? Math.max(cycleSeconds, deliveredAt) : cycleSeconds;
    var deliveries = 0;

    /* 积分：圈内击杀（t=0 一次性）→ 每轮送达 +1200 → 每 tick 定时加分；达到 15000 立即锁定 */
    var kills = {};
    var killPoints = {};
    var timedPoints = {};
    var deliveryGiven = {};
    var scores = {};
    fs.forEach(function (f) {
      kills[f.id] = Math.max(0, Math.round(pickNumber((params.kills || {})[f.id], 0)));
      killPoints[f.id] = kills[f.id] * killPts;
      timedPoints[f.id] = 0;
      deliveryGiven[f.id] = 0;
      scores[f.id] = killPoints[f.id];
    });

    var winner = null;
    var lockedAt = null;

    function checkLock(atSecond) {
      var topFid = null;
      var topScore = -1;
      var tieTop = false;
      fs.forEach(function (f) {
        var s = scores[f.id];
        if (s > topScore) { topScore = s; topFid = f.id; tieTop = false; }
        else if (s === topScore) tieTop = true;
      });
      if (topFid && topScore >= targetScore) {
        winner = topFid;
        lockedAt = atSecond;
        void tieTop; /* 同分同时达标的处理沿用「先到先得」，不额外拆分 */
        return true;
      }
      return false;
    }

    checkLock(0);
    for (var tt = 1; tt <= maxSeconds && lockedAt === null; tt++) {
      var changed = false;
      if (canDeliver && tt % roundSeconds === 0) {
        scores[carrier] += deliveryPoints;
        deliveryGiven[carrier] += deliveryPoints;
        deliveries++;
        changed = true;
      }
      if (tt % tickSeconds === 0) {
        fs.forEach(function (f) {
          if ((followCounts[f.id] || 0) <= 0) return;
          var pts = f.id === follower ? followerPoints : nearPoints;
          scores[f.id] += pts;
          timedPoints[f.id] += pts;
        });
        changed = true;
      }
      if (changed && checkLock(tt)) break;
    }

    var evalEnd = lockedAt !== null ? lockedAt : maxSeconds;

    function scoresAt(sec) {
      var pts = {};
      var at = Math.min(Math.max(0, sec), evalEnd);
      var ticks = Math.floor(at / tickSeconds);
      var roundsAt = canDeliver ? Math.floor(at / roundSeconds) : 0;
      fs.forEach(function (f) {
        pts[f.id] = killPoints[f.id]
          + (f.id === carrier ? deliveryPoints * roundsAt : 0)
          + (((followCounts[f.id] || 0) > 0 ? (f.id === follower ? followerPoints : nearPoints) : 0) * ticks);
      });
      return pts;
    }

    function leaderAt(pts) {
      var ids = Object.keys(pts);
      var top = -1;
      var topFid = null;
      ids.forEach(function (fid) {
        if (pts[fid] > top) { top = pts[fid]; topFid = fid; }
      });
      return topFid;
    }

    var finalTop = leaderAt(scores);
    var underdog = [];
    fs.forEach(function (f) {
      if (finalTop && (scores[finalTop] - scores[f.id]) >= underdogGap) underdog.push(f.id);
    });

    var snareEvents = [];
    var teleportEvents = [];
    var teleActivators = Math.max(1, Math.round(pickNumber(params.teleportActivators, cfg.teleActivators)));
    var mech = params.mech || {};

    for (var ts = snareEvery; ts <= evalEnd; ts += snareEvery) {
      var atSnare = scoresAt(ts);
      var topSnare = leaderAt(atSnare);
      fs.forEach(function (f) {
        if (topSnare && (atSnare[topSnare] - atSnare[f.id]) >= underdogGap) snareEvents.push({ t: ts, factionId: f.id });
      });
    }
    for (var tp = teleEvery; tp <= evalEnd; tp += teleEvery) {
      var atTele = scoresAt(tp);
      var topTele = leaderAt(atTele);
      fs.forEach(function (f) {
        if (topTele && (atTele[topTele] - atTele[f.id]) >= underdogGap) teleportEvents.push({ t: tp, factionId: f.id, activators: teleActivators });
      });
    }

    function markTriggered(list, key) {
      list.forEach(function (ev) {
        var rec = (mech[ev.factionId] || {})[key] || [];
        ev.triggered = rec.indexOf(ev.t) >= 0;
      });
    }
    markTriggered(snareEvents, 'snareTimes');
    markTriggered(teleportEvents, 'teleportTimes');

    var ownership = [];
    if (owner) ownership.push({ t: 0, factionId: owner });
    else ownership.push({ t: 0, factionId: null });

    return {
      mode: 'escort',
      counts: counts,
      followCounts: followCounts,
      circleRadius: circle ? (circle.captureRadius || circle.radius) : 7,
      total: total,
      owner: owner,
      tie: tie,
      follower: follower,
      followRadius: followRadius,
      followMinCount: followMin,
      carrier: carrier,
      destination: dest ? { id: dest.id, name: dest.name, x: dx, y: dy } : null,
      distance: round2(distance),
      speed: round2(speed),
      escorts: escorts,
      opponent: opponent,
      deliveredAt: deliveredAt,
      canDeliver: canDeliver,
      roundSeconds: roundSeconds,
      escortCycleSeconds: cycleSeconds,
      deliveries: deliveries,
      progress: round2(progress),
      status: status,
      timeline: timeline,
      scores: scores,
      killPoints: killPoints,
      kills: kills,
      killUnit: killPts,
      killEnabled: params.killEnabled !== false,
      timedPoints: timedPoints,
      deliveryPoints: deliveryPoints,
      deliveryGiven: deliveryGiven,
      tickSeconds: tickSeconds,
      nearPoints: nearPoints,
      followerPoints: followerPoints,
      targetScore: targetScore,
      winner: winner,
      lockedAt: lockedAt,
      underdog: underdog,
      ownerId: owner,
      snareEvents: snareEvents,
      teleportEvents: teleportEvents,
      underdogGap: underdogGap,
      snareIntervalSeconds: snareEvery,
      teleportIntervalSeconds: teleEvery,
      teleActivators: teleActivators,
      ownership: ownership,
      mech: mech,
      mechClockSeconds: Math.max(0, pickNumber(params.mechClockSeconds, 0)),
      error: deliveredAt === null ? (escorts <= 0 ? '无人护送，骑士停滞' : '未能抵达目标广场（模拟上限 ' + maxSeconds + ' 秒）') : ''
    };
  }

  /* ============================ 计算：猎龙之城（siege-capture） ============================ */

  function computeSiege(md, params, plan) {
    var fs = primaryFactions(md);
    var target = Math.max(1, Number(params.target) || DEFAULTS.siege.target);
    var perMember = Math.max(0, Number(params.perMemberPerSecond) || 0);
    var duration = Math.max(0, Math.round(Number(params.duration) || 0));
    var members = normalizeCounts(md, params.members);

    var rate = {};
    var score = {};
    var reachedAt = {};
    fs.forEach(function (f) {
      rate[f.id] = (members[f.id] || 0) * perMember;
      score[f.id] = 0;
    });

    var series = fs.map(function (f) {
      return { id: f.id, name: f.name, color: f.color, points: [{ t: 0, v: 0 }] };
    });
    var sample = Math.max(1, Math.ceil(duration / 120));

    for (var t = 1; t <= duration; t++) {
      fs.forEach(function (f) {
        score[f.id] = Math.min(target, score[f.id] + rate[f.id]);
        if (!reachedAt[f.id] && score[f.id] >= target) reachedAt[f.id] = t;
      });
      if (t % sample === 0 || t === duration) {
        fs.forEach(function (f, i) {
          series[i].points.push({ t: t, v: round2(score[f.id]) });
        });
      }
    }

    var winner = null;
    fs.forEach(function (f) {
      if (reachedAt[f.id] && (!winner || reachedAt[f.id] < reachedAt[winner])) winner = f.id;
    });

    var gates = ((md.siege && md.siege.gates) || []).map(function (g) {
      var st = plan ? GM.siegeGateState(plan, g) : 'locked';
      var unlocks = (g.unlocks || []).map(function (sid) {
        var s = null;
        ((md.siege && md.siege.steles) || []).forEach(function (x) { if (x.id === sid) s = x; });
        var owned = plan && plan.siege ? plan.siege.steles[sid] : null;
        return {
          id: sid,
          name: s ? s.name : sid,
          owner: owned,
          ok: owned === g.factionId
        };
      });
      return {
        id: g.id,
        name: g.name,
        factionId: g.factionId,
        factionName: factionById(g.factionId).name,
        state: st,
        label: GM.siegeGateLabel(st),
        unlocks: unlocks
      };
    });

    return {
      mode: 'siege',
      target: target,
      duration: duration,
      perMember: perMember,
      members: members,
      rate: rate,
      scores: score,
      series: series,
      reachedAt: reachedAt,
      winner: winner,
      gates: gates,
      totalSeconds: duration
    };
  }

  /* ============================ 图表 ============================ */

  function chartSvg(result) {
    var w = 700;
    var h = 216;
    var pl = 46;
    var pr = 14;
    var pt = 14;
    var pb = 26;
    var total = Math.max(1, result.totalSeconds || 1);
    var maxY = Math.max(result.target || 0, result.maxScore || 0, 10) * 1.1;

    function X(t) { return pl + (t / total) * (w - pl - pr); }
    function Y(v) { return h - pb - (v / maxY) * (h - pt - pb); }

    var out = '<svg class="sim-chart" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">';

    for (var i = 0; i <= 4; i++) {
      var v = maxY * i / 4;
      var y = Y(v);
      out += '<line x1="' + pl + '" y1="' + y.toFixed(1) + '" x2="' + (w - pr) + '" y2="' + y.toFixed(1) + '" stroke="#232c38" stroke-width="1"></line>' +
        '<text x="' + (pl - 7) + '" y="' + (y + 4).toFixed(1) + '" fill="#626a78" font-size="10" text-anchor="end">' + Math.round(v) + '</text>';
    }

    for (var j = 0; j <= 4; j++) {
      var t = total * j / 4;
      out += '<text x="' + X(t).toFixed(1) + '" y="' + (h - 8) + '" fill="#626a78" font-size="10" text-anchor="middle">' + Math.round(t) + 's</text>';
    }

    if (result.target) {
      out += '<line x1="' + pl + '" y1="' + Y(result.target).toFixed(1) + '" x2="' + (w - pr) + '" y2="' + Y(result.target).toFixed(1) + '" stroke="#7d6538" stroke-width="1" stroke-dasharray="6 5"></line>';
    }

    /* 高倍结算时间点：竖直虚线 + 倍率标签（四方战） */
    (result.highValue || []).forEach(function (hv) {
      var x = X(Math.min(Math.max(0, hv.atSecond), total));
      out += '<line x1="' + x.toFixed(1) + '" y1="' + pt + '" x2="' + x.toFixed(1) + '" y2="' + (h - pb) + '" stroke="#c9a55a" stroke-width="1" stroke-dasharray="3 3" opacity="0.75"></line>' +
        '<text x="' + x.toFixed(1) + '" y="' + (pt + 9) + '" fill="#c9a55a" font-size="9" text-anchor="middle">×' + hv.multiplier + '</text>';
    });

    result.series.forEach(function (s) {
      var pts = s.points.map(function (p) {
        return X(p.t).toFixed(1) + ',' + Y(p.v).toFixed(1);
      }).join(' ');
      out += '<polyline points="' + pts + '" fill="none" stroke="' + U.esc(s.color) + '" stroke-width="2"></polyline>';
      var last = s.points[s.points.length - 1];
      out += '<circle cx="' + X(last.t).toFixed(1) + '" cy="' + Y(last.v).toFixed(1) + '" r="2.5" fill="' + U.esc(s.color) + '"></circle>';
    });

    out += '</svg>';
    return out;
  }

  function legendHtml(result) {
    return '<div class="sim-legend">' + result.series.map(function (s) {
      var last = s.points[s.points.length - 1];
      return '<span class="sim-legend-item"><span class="sim-dot" style="background:' + U.esc(s.color) + '"></span>' +
        U.esc(s.name) + ' <b>' + round2(last.v) + '</b></span>';
    }).join('') + '</div>';
  }

  /* ============================ 结果面板 ============================ */

  function fmtScore(v) { return round2(v); }

  function renderCapture(result) {
    var winnerName = result.winner ? factionById(result.winner).name : '暂无';
    var verdict = result.lockedAt
      ? '第 ' + result.lockedAt + ' 秒率先达到 ' + result.target + ' 分，<b>' + U.esc(winnerName) + '</b> 锁定胜局'
      : '模拟 ' + result.totalSeconds + ' 秒无人达到 ' + result.target + ' 分 · 按积分排位：<b>' + U.esc(winnerName) + '</b>' +
        (result.tieBreakWinner ? '（同分，依次比总击杀数 / 非凡评分总和）' : '');

    var changes = result.leadChanges.slice(0, 6).map(function (c) {
      return '<li>第 ' + c.t + ' 秒：' + U.esc(factionById(c.factionId).name) + ' 取得领先</li>';
    }).join('');

    var rankHtml = result.ranking.map(function (r) {
      return '<li>#' + r.rank + ' ' + U.esc(r.name) + ' · ' + r.score + ' 分 · 击杀 ' + r.kills + ' · 非凡评分 ' + r.rating + '</li>';
    }).join('');

    var targets = result.forecast.map(function (f) {
      return '<li>' + U.esc(f.name) + '：' + U.esc(f.text) + '</li>';
    }).join('');
    var overtakes = result.overtakes.map(function (o) {
      return '<li>' + U.esc(o.name) + '：' + U.esc(o.text) + '（第 ' + o.at + ' 秒）</li>';
    }).join('');

    var highHtml = result.highValue.map(function (hv) {
      var who = hv.guardNames && hv.guardNames.length ? hv.guardNames.join(' + ') : '—';
      var extra = !hv.settled
        ? '该时间点未进入模拟（已提前锁定或结束）'
        : (hv.extraPoints > 0
          ? '额外 +' + hv.extraPoints + ' 分（组内已占领 ' + hv.ownedCount + ' 个）'
          : '该结算点组内无已占领守卫，无额外分');
      return '<li>第 ' + hv.atSecond + ' 秒（60 秒结算点）· ' + U.esc(hv.groupName) + '（' + U.esc(who) + '）· ×' +
        hv.multiplier + '（' + hv.pointsPerGuard + ' 分/守卫）· ' + extra + ' · 第 ' + hv.announceAt + ' 秒预告</li>';
    }).join('');

    var capHtml = result.captures.slice(0, 8).map(function (c) {
      var from = c.from ? factionById(c.from).name : '无归属';
      var to = c.to ? factionById(c.to).name : '无归属';
      var extra = c.to && c.respawn ? ' → 立即重生并归属本方' : '';
      return '<li>第 ' + c.t + ' 秒：' + U.esc(c.guardName) + ' ' + U.esc(from) + ' → ' + U.esc(to) + extra +
        (c.first ? '（首占 +' + c.points + '）' : '') + '</li>';
    }).join('');

    var cfg = result.config;
    return '' +
      '<div class="sim-verdict">' + verdict + '</div>' +
      '<div class="sim-chart-wrap">' + chartSvg(result) + '</div>' +
      legendHtml(result) +
      '<div class="sim-facts">' +
        '<div class="sim-fact"><span>结算参数</span><em>首占 +' + cfg.firstPts + ' · 每 ' + cfg.bigTick + ' 秒 +' + cfg.bigPts +
          '/守卫 · 高倍 ×4 = ' + (cfg.bigPts * 4) + '、×6 = ' + (cfg.bigPts * 6) + '（仅结算点落在窗口内时生效）· 目标 ' + result.target + ' 分</em></div>' +
        '<div class="sim-fact"><span>积分排位</span><ul class="sim-list">' + rankHtml + '</ul></div>' +
        '<div class="sim-fact"><span>高倍结算时间轴</span>' + (highHtml ? '<ul class="sim-list">' + highHtml + '</ul>' : '<em>该地图未配置高倍结算</em>') + '</div>' +
        '<div class="sim-fact"><span>夺权事件（最后一击）</span>' + (capHtml ? '<ul class="sim-list">' + capHtml + '</ul>' : '<em>时间轴内守卫归属未发生变化</em>') + '</div>' +
        '<div class="sim-fact"><span>领先更替</span>' + (changes ? '<ul class="sim-list">' + changes + '</ul>' : '<em>时间轴内无人取得领先（守卫可能全部无人占领）</em>') + '</div>' +
        '<div class="sim-fact"><span>维持当前归属的预测</span>' +
          '<ul class="sim-list">' + targets + '</ul>' +
          (overtakes ? '<ul class="sim-list">' + overtakes + '</ul>' : '') +
        '</div>' +
        '<div class="sim-fact"><span>说明</span><em>按 1 秒步长推进，但只在每 ' + cfg.bigTick + ' 秒节点结算一次；该结算点落在高倍窗口内时按刷新守卫位置的倍率放大（×4 / ×6）；率先 ' + result.target + ' 分即锁定，模拟在该秒停止。</em></div>' +
      '</div>';
  }

  function renderEscort(result) {
    var ownerName = result.owner ? factionById(result.owner).name : (result.tie ? '无归属（平局，按争议处理）' : '无归属');
    var countLine = primaryCountNames(result.counts);
    var followLine = primaryCountNames(result.followCounts || result.counts);
    var followerName = result.follower
      ? factionById(result.follower).name + '（' + ((result.followCounts || result.counts)[result.follower] || 0) + ' 人，≥ ' + result.followMinCount + ' 人）'
      : '无跟随（不足 ' + result.followMinCount + ' 人或并列且无原归属）';

    var leaderFid = null;
    var leaderScore = -1;
    Object.keys(result.scores).forEach(function (fid) {
      if (result.scores[fid] > leaderScore) { leaderScore = result.scores[fid]; leaderFid = fid; }
    });

    var scoreHtml = Object.keys(result.scores).map(function (fid) {
      var f = factionById(fid);
      var timed = (result.timedPoints && result.timedPoints[fid]) || 0;
      var kn = (result.kills && result.kills[fid]) || 0;
      var kp = (result.killPoints && result.killPoints[fid]) || 0;
      var dv = (result.deliveryGiven && result.deliveryGiven[fid]) || 0;
      var dn = fid === result.carrier ? (result.deliveries || 0) : 0;
      return '<li><span class="sim-dot" style="background:' + U.esc(f.color) + '"></span>' + U.esc(f.name) +
        ' <b>' + fmtScore(result.scores[fid]) + '</b> 分 = 定时 +' + fmtScore(timed) +
        ' · 圈内击杀 ' + (result.killEnabled ? (kn + ' × ' + result.killUnit + ' = +' + fmtScore(kp)) : '已关闭（记 ' + kn + ' 人）') +
        ' · 送达 ' + dn + ' × ' + result.deliveryPoints + ' = +' + fmtScore(dv) + '</li>';
    }).join('');

    var verdict = result.winner
      ? '第 ' + result.lockedAt + ' 秒达到 ' + result.targetScore + ' 分，<b>' + U.esc(factionById(result.winner).name) + '</b> 提前获胜（共送达 ' + result.deliveries + ' 次）'
      : '无人达到 ' + result.targetScore + ' 分（模拟至第 ' + (result.lockedAt !== null ? result.lockedAt : (result.timeline[result.timeline.length - 1] || {}).t || 0) + ' 秒，共送达 ' +
        result.deliveries + ' 次），当前领先：<b>' + U.esc(leaderFid ? factionById(leaderFid).name : '无') + '</b>（' + fmtScore(leaderScore) + ' 分）';

    var underName = result.underdog && result.underdog.length
      ? result.underdog.map(function (fid) { return factionById(fid).name + '（差 ' + fmtScore(result.scores[leaderFid] - result.scores[fid]) + '）'; }).join(' / ')
      : '无';

    var snareHtml = (result.snareEvents || []).map(function (ev) {
      return '<li>第 ' + ev.t + ' 秒 · ' + U.esc(factionById(ev.factionId).name) + ' · 绊马索 1 份' +
        (ev.triggered ? ' · 已触发' : ' · 未记录触发') + '</li>';
    }).join('') || '<li>模拟范围内无劣势势力达到 5 分钟投放点</li>';

    var teleportHtml = (result.teleportEvents || []).map(function (ev) {
      return '<li>第 ' + ev.t + ' 秒 · ' + U.esc(factionById(ev.factionId).name) + ' · 集合传送开启（需 ' +
        ev.activators + ' 人激活）' + (ev.triggered ? ' · 已触发' : ' · 未记录触发') + '</li>';
    }).join('') || '<li>模拟范围内无劣势势力达到 8 分钟开启点</li>';

    var manualHtml = '';
    Object.keys(result.mech || {}).forEach(function (fid) {
      var rec = result.mech[fid] || {};
      var sn = (rec.snareTimes || []).map(function (t) { return '绊马索@' + t + 's'; });
      var tp = (rec.teleportTimes || []).map(function (t) { return '传送@' + t + 's'; });
      if (sn.length || tp.length) {
        manualHtml += '<li>' + U.esc(factionById(fid).name) + '：' + U.esc(sn.concat(tp).join(' / ')) + '</li>';
      }
    });

    var lastEvents = result.timeline.slice(-6).map(function (e) {
      return '<li>第 ' + e.t + ' 秒：进度 ' + e.progress + ' / ' + result.distance + ' unit · ' + U.esc(e.status) + '</li>';
    }).join('');

    var ownershipLine = result.ownership.map(function (e) {
      return '<li>第 ' + e.t + ' 秒：' + U.esc(e.factionId ? factionById(e.factionId).name : '无归属（争议）') + '</li>';
    }).join('');

    return '' +
      '<div class="sim-verdict">' + verdict + '</div>' +
      '<div class="sim-facts">' +
        '<div class="sim-fact"><span>占领圈（判定圆）</span><em>归属：' + U.esc(ownerName) + ' · 圈内 ' + result.total +
          ' 人 · 半径 ' + result.circleRadius + ' unit</em></div>' +
        '<div class="sim-fact"><span>占领圈人数</span><em>' + countLine + '</em></div>' +
        '<div class="sim-fact"><span>跟随判定</span><em>跟随：' + U.esc(followerName) + ' · 跟随圆半径 ' + result.followRadius +
          ' unit（1 unit = 1 米为假设值）</em></div>' +
        '<div class="sim-fact"><span>跟随圆人数</span><em>' + followLine + '</em></div>' +
        '<div class="sim-fact"><span>归属变化序列</span><ul class="sim-list">' + ownershipLine + '</ul></div>' +
        '<div class="sim-fact"><span>护送</span><em>携带方：' + U.esc(factionById(result.carrier).name) +
          ' · 目的地：' + U.esc(result.destination ? result.destination.name : '未选择') +
          ' · 直线距离 ' + result.distance + ' unit · 速度 ' + result.speed + ' unit/秒</em></div>' +
        '<div class="sim-fact"><span>循环护送</span><em>' +
          (result.canDeliver
            ? '按速度估算本轮 ' + result.deliveredAt + ' 秒抵达；轮时长 ' + result.roundSeconds + ' 秒（单轮参数 ' + result.escortCycleSeconds +
              ' 秒，取二者较大值）；共送达 ' + result.deliveries + ' 次，累计送达分 +' + fmtScore(result.deliveries * result.deliveryPoints)
            : U.esc(result.error)) +
          '</em></div>' +
        '<div class="sim-fact"><span>各势力得分</span><ul class="sim-list">' + scoreHtml + '</ul>' +
          '<em>定时结算：每 ' + result.tickSeconds + ' 秒，圈内非跟随方 +' + result.nearPoints + '、跟随方 +' + result.followerPoints +
          '；圈内击杀单价 ' + result.killUnit + ' 分/人（' + (result.killEnabled ? '已启用' : '已关闭') + '，只算判定圆内）。</em></div>' +
        '<div class="sim-fact"><span>劣势势力</span><em>积分第一相差 ≥ ' + result.underdogGap + ' 分：' + U.esc(underName) + '</em></div>' +
        '<div class="sim-fact"><span>绊马索时间轴</span><ul class="sim-list">' + snareHtml + '</ul></div>' +
        '<div class="sim-fact"><span>集合传送时间轴</span><ul class="sim-list">' + teleportHtml + '</ul></div>' +
        (manualHtml ? '<div class="sim-fact"><span>手动触发记录</span><ul class="sim-list">' + manualHtml + '</ul></div>' : '') +
        '<div class="sim-fact"><span>推进片段</span><ul class="sim-list">' + lastEvents + '</ul></div>' +
        '<div class="sim-fact"><span>判定规则</span><em>跟随圆（半径 ' + result.followRadius + ' unit）内人数最多且 ≥ ' + result.followMinCount +
          ' 人的势力获得跟随；并列时保持原归属，无原归属则中立。圈内击杀只算占领圈判定圆（半径 ' + result.circleRadius +
          ' unit）。跟随圆内敌方人数多于护送方时骑士回退。</em></div>' +
      '</div>';
  }

  function primaryCountNames(counts) {
    var parts = [];
    Object.keys(counts).forEach(function (fid) {
      if (!counts[fid]) return;
      parts.push(factionById(fid).name + ' ' + counts[fid] + ' 人');
    });
    return parts.length ? parts.join(' / ') : '圈内暂无标记';
  }

  /* ============================ 计算：俱乐部宣战（club-war） ============================ */

  /* 攻守状态只由 plan.clubwar.ownership 推导：每个目标只有 未占领 / 已占领 两态。
     两座雕像都占领 → 屏障消失、守方只剩重生点/传送点、大旗可攻；否则屏障存在。 */
  function computeClubWar(md, plan) {
    GM.ensurePlanMeta(plan);
    var cfg = md.clubWar || {};
    var attacker = cfg.attacker || 'A';
    var defender = cfg.defender || 'B';
    var statueIds = cfg.statueIds || ['statue-up', 'statue-down'];
    var flagId = cfg.flagId || 'flag';
    var own = (plan && plan.clubwar && plan.clubwar.ownership) || {};

    var statues = statueIds.map(function (sid) {
      var o = findObjective(md, sid);
      return { id: sid, name: (o && o.name) || sid, held: own[sid] === true };
    });
    var bothHeld = statues.every(function (s) { return s.held; });
    var flagHeld = bothHeld && own[flagId] === true;

    var barrierPresent = !bothHeld;
    var teleportIds = bothHeld ? ['defender-spawn'] : ['defender-teleport', 'defender-spawn'];
    var targetNames = teleportIds.map(function (id) {
      var o = findObjective(md, id);
      return (o && o.name) || id;
    });

    return {
      attacker: attacker,
      defender: defender,
      statues: statues,
      bothHeld: bothHeld,
      flagHeld: flagHeld,
      barrierPresent: barrierPresent,
      targetNames: targetNames,
      flagAttackable: bothHeld,
      winner: flagHeld ? attacker : null
    };
  }

  function renderClubWar(r) {
    var atk = factionById(r.attacker);
    var def = factionById(r.defender);
    var statueText = r.statues.map(function (s) {
      return s.name + '：' + (s.held ? '已占领' : '未占领');
    }).join(' · ');
    var teleports = r.targetNames.join('、');

    var verdict = r.flagHeld
      ? '大旗已占领 · <b>' + U.esc(atk.name) + '（攻方）胜</b>'
      : '攻方 ' + U.esc(atk.name) + ' / 守方 ' + U.esc(def.name) + ' · 暂未分胜负';

    return '' +
      '<div class="sim-verdict">' + verdict + '</div>' +
      '<div class="sim-facts">' +
        '<div class="sim-fact"><span>战争雕像</span><em>' + U.esc(statueText) + '</em></div>' +
        '<div class="sim-fact"><span>屏障</span><span class="gate-state ' + (r.barrierPresent ? 'locked' : 'broken') + '">' +
          (r.barrierPresent ? '存在' : '已消失') + '</span></div>' +
        '<div class="sim-fact"><span>守方可传送目标</span><em>' + U.esc(teleports) + '</em></div>' +
        '<div class="sim-fact"><span>大旗</span><em>' + (r.flagHeld ? '已占领' : '未占领 · ' + (r.flagAttackable ? '可攻' : '不可攻')) + '</em></div>' +
      '</div>';
  }

  function renderSiege(result) {
    var bars = Object.keys(result.scores).map(function (fid) {
      var f = factionById(fid);
      var val = result.scores[fid];
      var pct = Math.min(100, (val / result.target) * 100);
      return '<div class="sim-bar-row">' +
        '<span class="sim-bar-name"><span class="sim-dot" style="background:' + U.esc(f.color) + '"></span>' + U.esc(f.name) + '</span>' +
        '<span class="sim-bar"><span class="sim-bar-fill" style="width:' + pct.toFixed(1) + '%;background:linear-gradient(90deg,' + U.esc(f.color) + '55,' + U.esc(f.color) + ')"></span></span>' +
        '<span class="sim-bar-val">' + round2(val) + '%</span>' +
        (result.reachedAt[fid] ? '<span class="sim-bar-tag">第 ' + result.reachedAt[fid] + ' 秒达标</span>' : '') +
        '</div>';
    }).join('');

    var gates = result.gates.map(function (g) {
      var cls = g.state === 'broken' ? 'broken' : (g.state === 'ready' ? 'ready' : 'locked');
      var unlockText = g.unlocks.map(function (u) {
        return U.esc(u.name) + (u.ok ? '✓' : '✗');
      }).join(' + ');
      return '<div class="sim-gate-row">' +
        '<span class="gate-name">' + U.esc(g.name) + ' · ' + U.esc(g.factionName) + '</span>' +
        '<span class="gate-state ' + cls + '">' + U.esc(g.label) + '</span>' +
        '<span class="sim-gate-req">' + unlockText + '</span>' +
        '</div>';
    }).join('');

    var winnerName = result.winner ? factionById(result.winner).name : '暂无人达标';

    return '' +
      '<div class="sim-verdict">台上每人每秒 ' + round2(result.perMember || 0) + '% 累计 · 目标 ' + result.target + '% · ' + result.duration + ' 秒后：<b>' + U.esc(winnerName) + '</b></div>' +
      '<div class="sim-bars">' + bars + '</div>' +
      '<div class="sim-facts">' +
        '<div class="sim-fact"><span>当前可攻城门</span><div class="sim-gates">' + (gates || '<em>该地图无城门配置</em>') + '</div></div>' +
        '<div class="sim-fact"><span>说明</span><em>台上人数来自沙盘标记（按队伍人数），可在上方手动覆盖；百分比按每秒累加，达到目标即停止。</em></div>' +
      '</div>';
  }

  function renderResult() {
    var host = q('#simResult');
    if (!host) return;
    var md = GM.currentMap();
    if (!md) { host.innerHTML = ''; return; }

    if (md.mode === 'capture') {
      var cap = computeCapture(md, state.capture);
      host.innerHTML = renderCapture(cap);
    } else if (md.mode === 'escort') {
      var esc = computeEscort(md, state.escort);
      host.innerHTML = renderEscort(esc);
    } else if (md.mode === 'siege-capture') {
      var sie = computeSiege(md, state.siege, GM.activePlan());
      host.innerHTML = renderSiege(sie);
    } else if (md.mode === 'club-war') {
      host.innerHTML = renderClubWar(computeClubWar(md, GM.activePlan()));
    } else {
      host.innerHTML = '<div class="sim-empty">当前地图为自由沙盘，暂无可推演规则。</div>';
    }
  }

  /* ============================ 参数面板 ============================ */

  function numField(label, id, value, min, max, step) {
    return '<label class="sim-field"><span>' + U.esc(label) + '</span>' +
      '<input type="number" id="' + id + '" min="' + min + '" max="' + max + '" step="' + (step || 1) + '" value="' + value + '"></label>';
  }

  function ownerSelect(phaseIndex, o, current, allowNone) {
    var opts = '';
    if (allowNone) opts += '<option value=""' + (!current ? ' selected' : '') + '>无归属</option>';
    factions().forEach(function (f) {
      opts += '<option value="' + U.esc(f.id) + '"' + (current === f.id ? ' selected' : '') + '>' + U.esc(f.name) + '</option>';
    });
    return '<label class="sim-obj"><span>' + U.esc(o.name) + '</span>' +
      '<select data-owner-phase="' + phaseIndex + '" data-owner-obj="' + U.esc(o.id) + '">' + opts + '</select></label>';
  }

  function facField(label, fid, kind, value) {
    return '<label class="sim-field"><span>' + U.esc(label) + '</span>' +
      '<input type="number" min="0" max="9999" step="1" data-' + kind + '-fid="' + U.esc(fid) + '" value="' + value + '"></label>';
  }

  function clubControls(md, c) {
    var fs = primaryFactions(md);
    var fid = c.clubFactionId || fs[0].id;
    var clubOpts = fs.map(function (f) {
      return '<option value="' + U.esc(f.id) + '"' + (f.id === fid ? ' selected' : '') + '>' + U.esc(f.name) + '</option>';
    }).join('');
    var cdMap = c.cooldowns[fid] || {};

    var skills = (md.commands || []).map(function (cmd) {
      var left = Math.max(0, Number(cdMap[cmd.id]) || 0);
      return '<div class="sim-skill-row">' +
        '<span class="sim-skill-name">' + U.esc(cmd.name) + '<em>' + U.esc(cmd.effect) + '</em></span>' +
        '<span class="sim-skill-cost">' + cmd.cost + ' 资源 · CD ' + cmd.cooldownSeconds + 's</span>' +
        '<button type="button" class="btn mini" data-skill-fid="' + U.esc(fid) + '" data-skill-id="' + U.esc(cmd.id) + '"' +
          (left > 0 ? ' disabled' : '') + '>' + (left > 0 ? ('冷却 ' + left + 's') : '释放') + '</button>' +
        '</div>';
    }).join('');

    return '<div class="sim-subhead"><span>俱乐部资源 / 士气 / 指挥技能</span></div>' +
      '<div class="sim-fields">' +
        '<label class="sim-field"><span>俱乐部</span><select id="simClubFaction">' + clubOpts + '</select></label>' +
        numField('资源点', 'simResources', c.resources[fid] || 0, 0, 99999, 10) +
        numField('士气等级', 'simMorale', c.morale[fid] || 0, 0, 99, 1) +
        numField('资源获取速率（点/分钟 · 假设）', 'simResourceRate', c.resourceRatePerMinute, 0, 9999, 10) +
      '</div>' +
      '<div class="sim-skill-list">' + skills + '</div>' +
      '<div class="sim-tip">会长 / 外交官 / 理事才能释放；消耗与 CD 为规则原文数值。资源获取速率不在官方规则里，按假设值输入。冷却按 1 秒倒计时，关闭推演面板后暂停。</div>';
  }

  function captureControls(md) {
    var c = state.capture;
    var sc = md.scoring || {};
    var roster = sc.roster || {};
    var hv = sc.highValue || {};
    var hvGroups = hv.groups || [];
    function objNameOf(id) {
      var hit = null;
      (md.objectives || []).forEach(function (o) { if (o.id === id) hit = o; });
      return hit ? hit.name : id;
    }
    var hvRows = hvGroups.map(function (g) {
      var names = (g.guards || []).map(objNameOf).join(' + ');
      var mul = (c.highGroups && c.highGroups[g.id]) || g.multiplier;
      return '<label class="sim-field"><span>' + U.esc(g.name || g.id) + '（' + U.esc(names) + '）· 倍率</span>' +
        '<input type="number" min="1" max="10" step="1" data-hv-group="' + U.esc(g.id) + '" value="' + mul + '"></label>';
    }).join('');

    var html = '<div class="sim-fields">' +
      numField('结算周期（秒）', 'simBigTick', c.bigTickSeconds, 1, 300, 1) +
      numField('每守卫分值', 'simBigPts', c.bigPointsPerGuard, 0, 500, 1) +
      numField('首占加分', 'simFirst', c.firstCapturePoints, 0, 500, 1) +
      numField('目标分', 'simTarget', c.targetScore, 1, 10000, 1) +
      numField('单局时长（秒）', 'simDuration', c.durationSeconds, 1, 3600, 1) +
      '</div>';

    html += '<div class="sim-subhead"><span>高倍点位组（倍率可改 · 默认 4 / 4 / 6 为假设值）</span></div>' +
      '<div class="sim-fields">' + (hvRows || '<em>该地图未配置高倍点位组</em>') + '</div>';

    html += '<div class="sim-tip">官方规则：每家 ' + (roster.membersPerClub || 60) + ' 人（单局 ' + (roster.totalPlayers || 240) +
      ' 人），单一途径最多 ' + (roster.maxSamePathway || 16) + ' 人。高倍在 240 / 480 / 720 / 960 / 1200 秒按序号轮转抽中一组（g3 → g24 → g15），' +
      '只有组内且当前已归属的守卫按 18×倍率结算，组外守卫仍按 18；提前 ' + (hv.announceLeadSeconds || 90) + ' 秒预告。</div>';

    html += '<div class="sim-subhead"><span>阶段 / 时间轴</span><button type="button" class="btn mini" id="simAddPhase">＋阶段</button>' +
      '<button type="button" class="btn mini" id="simLoadOwners">按当前归属填充阶段 1</button></div>';
    html += '<div class="sim-phase-list">';

    c.phases.forEach(function (p, i) {
      html += '<div class="sim-phase" data-phase="' + i + '">' +
        '<div class="sim-phase-top"><span class="sim-phase-name">阶段 ' + (i + 1) + '</span>' +
        '<label class="sim-field inline"><span>秒数</span><input type="number" min="0" max="3600" step="1" data-phase-seconds="' + i + '" value="' + p.seconds + '"></label>' +
        (c.phases.length > 1 ? '<button type="button" class="sim-x" data-phase-remove="' + i + '" title="删除该阶段">×</button>' : '') +
        '</div><div class="sim-obj-grid">';

      (md.objectives || []).forEach(function (o) {
        html += ownerSelect(i, o, p.owners[o.id], true);
      });

      html += '</div></div>';
    });

    html += '</div>';
    html += '<div class="sim-tip">阶段按顺序累加；某守卫在阶段内选「无归属」则不计分。阶段起点视为「最后一击夺权 → 守卫立即重生并归属本方」，不模拟重生等待。</div>';

    html += '<div class="sim-subhead"><span>同分排序输入（击杀数 → 非凡评分总和）</span></div><div class="sim-fields">' +
      primaryFactions(md).map(function (f) {
        return facField(f.name + ' · 击杀', f.id, 'kill', c.kills[f.id] || 0) +
          facField(f.name + ' · 非凡评分', f.id, 'rating', c.rating[f.id] || 0);
      }).join('') +
      '</div>';

    html += clubControls(md, c);
    return html;
  }

  function escortControls(md) {
    var e = state.escort;
    var destOpts = ((md.escort && md.escort.returnTargets) || []).map(function (id) {
      var o = findObjective(md, id);
      return '<option value="' + U.esc(id) + '"' + (id === e.destinationId ? ' selected' : '') + '>' + U.esc(o ? o.name : id) + '</option>';
    }).join('');

    var carrierOpts = primaryFactions(md).map(function (f) {
      return '<option value="' + U.esc(f.id) + '"' + (f.id === e.carrier ? ' selected' : '') + '>' + U.esc(f.name) + '</option>';
    }).join('');

    var circles = findCaptureCircle(md);

    var mechLog = primaryFactions(md).map(function (f) {
      var rec = e.mech[f.id] || { snareTimes: [], teleportTimes: [] };
      var parts = (rec.snareTimes || []).map(function (t) { return '绊马索@' + t + 's'; })
        .concat((rec.teleportTimes || []).map(function (t) { return '传送@' + t + 's'; }));
      return '<label class="sim-field"><span>' + U.esc(f.name) + '</span>' +
        '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">' +
        '<button type="button" class="btn mini" data-snare-fid="' + U.esc(f.id) + '">记绊马索</button>' +
        '<button type="button" class="btn mini" data-teleport-fid="' + U.esc(f.id) + '">记传送</button>' +
        '<em style="font-size:10px;color:var(--dim)">' + U.esc(parts.join(' / ') || '未记录') + '</em>' +
        '</div></label>';
    }).join('');

    return '<div class="sim-subhead"><span>占领圈人数（判定圆 ' + (circles ? (circles.captureRadius || circles.radius) : 7) +
      ' unit · 用于归属与圈内击杀口径）</span><button type="button" class="btn mini" id="simReadCounts">读取沙盘人数</button></div>' +
      '<div class="sim-fields">' +
      primaryFactions(md).map(function (f) {
        return '<label class="sim-field"><span>' + U.esc(f.name) + '</span>' +
          '<input type="number" min="0" max="150" step="1" data-count-fid="' + U.esc(f.id) + '" value="' + (e.counts[f.id] || 0) + '"></label>';
      }).join('') +
      '</div>' +
      '<div class="sim-subhead"><span>跟随圆人数（半径 ' + e.followRadius + ' unit · 跟随与护送判定）</span></div>' +
      '<div class="sim-fields">' +
      primaryFactions(md).map(function (f) {
        return '<label class="sim-field"><span>' + U.esc(f.name) + '</span>' +
          '<input type="number" min="0" max="150" step="1" data-follow-count-fid="' + U.esc(f.id) + '" value="' + ((e.followCounts || {})[f.id] || 0) + '"></label>';
      }).join('') +
      '</div>' +
      '<div class="sim-fields">' +
      '<label class="sim-field"><span>携带方（护送方）</span><select id="simCarrier">' + carrierOpts + '</select></label>' +
      '<label class="sim-field"><span>目标广场</span><select id="simDestination">' + destOpts + '</select></label>' +
      '</div>' +
      '<div class="sim-subhead"><span>跟随与定时加分</span></div>' +
      '<div class="sim-fields">' +
      numField('跟随半径（unit）', 'simFollowRadius', e.followRadius, 0, 200, 1) +
      numField('跟随最少人数', 'simFollowMin', e.followMinCount, 1, 60, 1) +
      numField('定时周期（秒）', 'simEscortTick', e.tickSeconds, 1, 120, 1) +
      numField('非跟随方每次加分', 'simNearPts', e.nearPoints, 0, 500, 1) +
      numField('跟随方每次加分', 'simFollowerPts', e.followerPoints, 0, 500, 1) +
      '</div>' +
      '<div class="sim-subhead"><span>目标与护送</span></div>' +
      '<div class="sim-fields">' +
      numField('目标分（提前获胜）', 'simEscortTarget', e.targetScore, 1, 50000, 100) +
      numField('送达广场加分', 'simDelivery', e.deliveryPoints, 0, 5000, 10) +
      numField('单轮护送耗时（秒 · 假设）', 'simEscortCycle', e.escortCycleSeconds, 10, 600, 10) +
      numField('推演时长（秒）', 'simEscortDuration', e.durationSeconds, 60, 3600, 30) +
      numField('基础速度（unit/秒）', 'simBaseSpeed', e.baseSpeed, 1, 200, 1) +
      numField('每名额外护送者加速（unit/秒）', 'simPerSpeed', e.perEscorterSpeed, 0, 100, 1) +
      numField('被截断回退速度（unit/秒）', 'simRetreat', e.retreatSpeed, 0, 100, 1) +
      '</div>' +
      '<div class="sim-subhead"><span>圈内击杀（判定圆半径 ' + (circles ? (circles.captureRadius || circles.radius) : 7) + ' unit）</span></div>' +
      '<div class="sim-fields">' +
      numField('击杀单价（分/人）', 'simEscortKillPts', e.killInsideCircle, 0, 200, 1) +
      '<label class="sim-field"><span>圈内击杀计分</span><input type="checkbox" id="simKillEnabled"' + (e.killEnabled ? ' checked' : '') + '></label>' +
      primaryFactions(md).map(function (f) {
        return '<label class="sim-field"><span>' + U.esc(f.name) + ' 圈内击杀数</span>' +
          '<input type="number" min="0" max="500" step="1" data-escort-kill-fid="' + U.esc(f.id) + '" value="' + (e.kills[f.id] || 0) + '"></label>';
      }).join('') +
      '</div>' +
      '<div class="sim-subhead"><span>劣势势力机制</span></div>' +
      '<div class="sim-fields">' +
      numField('劣势差（分）', 'simUnderdogGap', e.underdogGap, 0, 50000, 100) +
      numField('绊马索间隔（秒）', 'simSnareEvery', e.snareIntervalSeconds, 1, 1800, 10) +
      numField('集合传送间隔（秒）', 'simTeleEvery', e.teleportIntervalSeconds, 1, 1800, 10) +
      numField('传送激活人数', 'simTeleActivators', e.teleportActivators, 1, 10, 1) +
      numField('记数用当前秒数', 'simMechClock', e.mechClockSeconds, 0, 3600, 1) +
      '</div>' +
      '<div class="sim-fields">' + mechLog + '</div>' +
      '<div class="sim-tip">中央占领圈为中立单位，可用鼠标拖动圆心。归属与圈内击杀口径用判定圆 captureRadius（' +
      (circles ? (circles.captureRadius || circles.radius) : 7) + ' unit）；跟随与护送人数用跟随圆（默认 ' + e.followRadius +
      ' unit，1 unit = 1 米为假设值）。改跟随半径后请点「读取沙盘人数」重新取数。定时周期与分值、击杀单价均为假设值，可调。机制按钮只在劣势势力（差 ≥ ' + e.underdogGap + '）时才会命中时间轴。</div>';
  }

  function siegeControls(md) {
    var s = state.siege;
    return '<div class="sim-subhead"><span>台上人数</span><button type="button" class="btn mini" id="simReadCounts">读取沙盘高台人数</button></div>' +
      '<div class="sim-fields">' +
      primaryFactions(md).map(function (f) {
        return '<label class="sim-field"><span>' + U.esc(f.name) + '</span>' +
          '<input type="number" min="0" max="150" step="1" data-member-fid="' + U.esc(f.id) + '" value="' + (s.members[f.id] || 0) + '"></label>';
      }).join('') +
      '</div>' +
      '<div class="sim-fields">' +
      numField('每人每秒贡献（%）', 'simPerMember', s.perMemberPerSecond, 0, 20, 0.1) +
      numField('总分目标（%）', 'simSiegeTarget', s.target, 1, 1000, 1) +
      numField('模拟时长（秒）', 'simDuration', s.duration, 1, 1800, 1) +
      '</div>' +
      '<div class="sim-tip">石碑归属与城门状态直接复用当前方案的攻城态势；改动请点沙盘上的石碑/城门热区。</div>';
  }

  function clubWarControls(md) {
    var plan = GM.activePlan();
    GM.ensurePlanMeta(plan);
    var cw = plan.clubwar;
    var cfg = md.clubWar || {};
    var statueIds = cfg.statueIds || [];
    var flagId = cfg.flagId || 'flag';
    var own = cw.ownership || {};
    var bothHeld = statueIds.every(function (sid) { return own[sid] === true; });

    var statueRows = statueIds.map(function (sid) {
      var o = findObjective(md, sid);
      return '<label class="sim-field"><span>' + U.esc((o && o.name) || sid) + ' · ' +
        (own[sid] === true ? '已占领' : '未占领') + '</span>' +
        '<input type="checkbox" data-club-statue="' + U.esc(sid) + '"' + (own[sid] === true ? ' checked' : '') + '></label>';
    }).join('');

    var flagName = (findObjective(md, flagId) || {}).name || '大旗';
    var flagRow = '<label class="sim-field"><span>' + U.esc(flagName) + ' · ' +
      (bothHeld && own[flagId] === true ? '已占领' : '未占领') + '</span>' +
      '<input type="checkbox" id="simClubFlag"' + (bothHeld && own[flagId] === true ? ' checked' : '') +
      (bothHeld ? '' : ' disabled') + '></label>';

    return '<div class="sim-subhead"><span>目标状态</span></div>' +
      '<div class="sim-fields">' + statueRows + flagRow + '</div>' +
      '<div class="sim-tip">点击切换 未占领 / 已占领。两座战争雕像均<b>已占领</b>后大旗才可勾选；任一雕像回到未占领时，大旗自动回落到未占领。改动写入当前方案。</div>';
  }

  function buildControls(md) {
    var host = q('#simControls');
    if (!host) return;
    var modeTag = q('#simModeTag');
    if (modeTag) modeTag.textContent = md ? md.modeLabel : '';

    var note = md && md.mode === 'capture'
      ? '<div class="sim-note">四方战数值为<b>官方规则原文</b>（来自 maps.js），面板修改只影响本次推演；修改立即重算，默认不写入存档。</div>'
      : (md && md.mode === 'club-war'
        ? '<div class="sim-note">大旗解锁与屏障状态由两座战争雕像是否都已占领推导；目标只有 未占领 / 已占领 两态。</div>'
        : '<div class="sim-note">所有系数均为<b>假设值，可调</b>；修改立即重算，默认不写入存档。</div>');

    if (!md) { host.innerHTML = note; return; }
    if (md.mode === 'capture') host.innerHTML = note + captureControls(md);
    else if (md.mode === 'escort') host.innerHTML = note + escortControls(md);
    else if (md.mode === 'siege-capture') host.innerHTML = note + siegeControls(md);
    else if (md.mode === 'club-war') { GM.ensurePlanMeta(GM.activePlan()); host.innerHTML = note + clubWarControls(md); }
    else host.innerHTML = note + '<div class="sim-empty">当前地图暂无推演规则（霍纳奇斯山脉本轮只做沙盘与规则说明）。</div>';
  }

  /* ============================ 交互 ============================ */

  var lastKey = null;

  function hasRunningCooldown() {
    var c = state.capture;
    if (!c || !c.cooldowns) return false;
    var any = false;
    Object.keys(c.cooldowns).forEach(function (fid) {
      Object.keys(c.cooldowns[fid]).forEach(function (sid) {
        if (Number(c.cooldowns[fid][sid]) > 0) any = true;
      });
    });
    return any;
  }

  function syncContext(force) {
    var md = GM.currentMap();
    var plan = GM.activePlan();
    var key = (md ? md.id : '') + '|' + (plan ? plan.id : '');
    if (!force && key === lastKey) return;
    lastKey = key;
    loadState(md, plan);
    buildControls(md);
    renderResult();
    if (md && md.mode === 'capture' && hasRunningCooldown()) startCdTimer();
  }

  function updateNumber(target, apply) {
    var v = Number(target.value);
    if (!isFinite(v)) return;
    apply(v);
    renderResult();
  }

  function onControlsInput(e) {
    var t = e.target;
    var md = GM.currentMap();
    if (!t || !md) return;

    if (md.mode === 'capture' && state.capture) {
      var c = state.capture;
      if (t.id === 'simBigTick') updateNumber(t, function (v) { c.bigTickSeconds = Math.round(U.clamp(v, 1, 300)); });
      else if (t.id === 'simBigPts') updateNumber(t, function (v) { c.bigPointsPerGuard = U.clamp(v, 0, 500); });
      else if (t.hasAttribute('data-hv-group')) {
        var gid = t.getAttribute('data-hv-group');
        updateNumber(t, function (v) { c.highGroups[gid] = Math.round(U.clamp(v, 1, 10)); });
      }
      else if (t.id === 'simFirst') updateNumber(t, function (v) { c.firstCapturePoints = U.clamp(v, 0, 500); });
      else if (t.id === 'simTarget') updateNumber(t, function (v) { c.targetScore = U.clamp(v, 1, 10000); });
      else if (t.id === 'simDuration') updateNumber(t, function (v) { c.durationSeconds = Math.round(U.clamp(v, 1, 3600)); });
      else if (t.id === 'simResources') updateNumber(t, function (v) { c.resources[c.clubFactionId] = Math.round(U.clamp(v, 0, 99999)); });
      else if (t.id === 'simMorale') updateNumber(t, function (v) { c.morale[c.clubFactionId] = Math.round(U.clamp(v, 0, 99)); });
      else if (t.id === 'simResourceRate') updateNumber(t, function (v) { c.resourceRatePerMinute = U.clamp(v, 0, 9999); });
      else if (t.hasAttribute('data-kill-fid')) {
        var kfid = t.getAttribute('data-kill-fid');
        updateNumber(t, function (v) { c.kills[kfid] = Math.round(U.clamp(v, 0, 9999)); });
      } else if (t.hasAttribute('data-rating-fid')) {
        var rfid = t.getAttribute('data-rating-fid');
        updateNumber(t, function (v) { c.rating[rfid] = Math.round(U.clamp(v, 0, 9999)); });
      } else if (t.hasAttribute('data-phase-seconds')) {
        var idx = Number(t.getAttribute('data-phase-seconds'));
        if (c.phases[idx]) updateNumber(t, function (v) { c.phases[idx].seconds = Math.round(U.clamp(v, 0, 3600)); });
      }
      return;
    }

    if (md.mode === 'escort' && state.escort) {
      var esc = state.escort;
      if (t.hasAttribute('data-count-fid')) {
        var fid = t.getAttribute('data-count-fid');
        updateNumber(t, function (v) { esc.counts[fid] = Math.round(U.clamp(v, 0, 150)); });
      } else if (t.hasAttribute('data-follow-count-fid')) {
        var ffid = t.getAttribute('data-follow-count-fid');
        updateNumber(t, function (v) { esc.followCounts[ffid] = Math.round(U.clamp(v, 0, 150)); });
      } else if (t.hasAttribute('data-escort-kill-fid')) {
        var kfid = t.getAttribute('data-escort-kill-fid');
        updateNumber(t, function (v) { esc.kills[kfid] = Math.round(U.clamp(v, 0, 500)); });
      } else if (t.id === 'simBaseSpeed') updateNumber(t, function (v) { esc.baseSpeed = U.clamp(v, 1, 200); });
      else if (t.id === 'simPerSpeed') updateNumber(t, function (v) { esc.perEscorterSpeed = U.clamp(v, 0, 100); });
      else if (t.id === 'simRetreat') updateNumber(t, function (v) { esc.retreatSpeed = U.clamp(v, 0, 100); });
      else if (t.id === 'simFollowRadius') updateNumber(t, function (v) { esc.followRadius = U.clamp(v, 0, 200); });
      else if (t.id === 'simFollowMin') updateNumber(t, function (v) { esc.followMinCount = Math.round(U.clamp(v, 1, 60)); });
      else if (t.id === 'simEscortTick') updateNumber(t, function (v) { esc.tickSeconds = Math.round(U.clamp(v, 1, 120)); });
      else if (t.id === 'simNearPts') updateNumber(t, function (v) { esc.nearPoints = U.clamp(v, 0, 500); });
      else if (t.id === 'simFollowerPts') updateNumber(t, function (v) { esc.followerPoints = U.clamp(v, 0, 500); });
      else if (t.id === 'simEscortTarget') updateNumber(t, function (v) { esc.targetScore = U.clamp(v, 1, 50000); });
      else if (t.id === 'simDelivery') updateNumber(t, function (v) { esc.deliveryPoints = U.clamp(v, 0, 5000); });
      else if (t.id === 'simEscortCycle') updateNumber(t, function (v) { esc.escortCycleSeconds = Math.round(U.clamp(v, 10, 600)); });
      else if (t.id === 'simEscortDuration') updateNumber(t, function (v) { esc.durationSeconds = Math.round(U.clamp(v, 60, 3600)); });
      else if (t.id === 'simEscortKillPts') updateNumber(t, function (v) { esc.killInsideCircle = U.clamp(v, 0, 200); });
      else if (t.id === 'simUnderdogGap') updateNumber(t, function (v) { esc.underdogGap = U.clamp(v, 0, 50000); });
      else if (t.id === 'simSnareEvery') updateNumber(t, function (v) { esc.snareIntervalSeconds = Math.round(U.clamp(v, 1, 1800)); });
      else if (t.id === 'simTeleEvery') updateNumber(t, function (v) { esc.teleportIntervalSeconds = Math.round(U.clamp(v, 1, 1800)); });
      else if (t.id === 'simTeleActivators') updateNumber(t, function (v) { esc.teleportActivators = Math.round(U.clamp(v, 1, 10)); });
      else if (t.id === 'simMechClock') updateNumber(t, function (v) { esc.mechClockSeconds = Math.round(U.clamp(v, 0, 3600)); });
      return;
    }

    if (md.mode === 'siege-capture' && state.siege) {
      var sie = state.siege;
      if (t.hasAttribute('data-member-fid')) {
        var mfid = t.getAttribute('data-member-fid');
        updateNumber(t, function (v) { sie.members[mfid] = Math.round(U.clamp(v, 0, 150)); });
      } else if (t.id === 'simPerMember') updateNumber(t, function (v) { sie.perMemberPerSecond = U.clamp(v, 0, 20); });
      else if (t.id === 'simSiegeTarget') updateNumber(t, function (v) { sie.target = U.clamp(v, 1, 1000); });
      else if (t.id === 'simDuration') updateNumber(t, function (v) { sie.duration = Math.round(U.clamp(v, 1, 1800)); });
      return;
    }
  }

  function onControlsChange(e) {
    var t = e.target;
    var md = GM.currentMap();
    if (!t || !md) return;

    if (md.mode === 'capture' && state.capture) {
      if (t.id === 'simClubFaction') {
        state.capture.clubFactionId = t.value;
        buildControls(md);
        return;
      }
      if (t.hasAttribute('data-owner-phase')) {
        var pi = Number(t.getAttribute('data-owner-phase'));
        var oid = t.getAttribute('data-owner-obj');
        if (state.capture.phases[pi]) {
          state.capture.phases[pi].owners[oid] = t.value || null;
          renderResult();
        }
        return;
      }
    }

    if (md.mode === 'escort' && state.escort) {
      if (t.id === 'simCarrier') {
        state.escort.carrier = t.value;
        renderResult();
      } else if (t.id === 'simDestination') {
        state.escort.destinationId = t.value;
        renderResult();
      } else if (t.id === 'simKillEnabled') {
        state.escort.killEnabled = !!t.checked;
        renderResult();
      }
      return;
    }

    if (md.mode === 'club-war') {
      var plan = GM.activePlan();
      if (!plan) return;
      GM.ensurePlanMeta(plan);
      var cwp = plan.clubwar;
      var cfg = md.clubWar || {};
      var statueIds = cfg.statueIds || [];
      var flagId = cfg.flagId || 'flag';
      var own = cwp.ownership;

      if (t.hasAttribute('data-club-statue')) {
        var sid = t.getAttribute('data-club-statue');
        own[sid] = !!t.checked;
        var bothHeld = statueIds.every(function (id) { return own[id] === true; });
        /* 任一雕像回到未占领：大旗复选框重新禁用，大旗自身一并回落到未占领 */
        if (!bothHeld) own[flagId] = false;
        GM.commit('推演雕像占领');
        GM.ui.toast((own[sid] ? '已占领' : '未占领') + '「' +
          ((findObjective(md, sid) || {}).name || sid) + '」' +
          (bothHeld ? '：两座雕像均已占领，大旗可攻' : '：屏障维持，大旗不可攻'),
          t.checked ? 'success' : 'error');
        return;
      }

      if (t.id === 'simClubFlag') {
        var both = statueIds.every(function (id) { return own[id] === true; });
        if (!both) {
          own[flagId] = false;
          GM.commit('推演大旗回落');
          GM.ui.toast('两座雕像未全部占领，大旗保持未占领', 'error');
          return;
        }
        own[flagId] = !!t.checked;
        GM.commit('推演大旗占领');
        GM.ui.toast(t.checked ? '大旗已占领 · 攻方获胜' : '大旗回到未占领', t.checked ? 'success' : '');
        return;
      }
    }
  }

  /* ============================ 指挥技能冷却 ============================ */

  var cdTimer = null;

  function setCdButton(fid, sid, left) {
    var el = document.querySelector('[data-skill-fid="' + fid + '"][data-skill-id="' + sid + '"]');
    if (!el) return;
    el.disabled = left > 0;
    el.textContent = left > 0 ? ('冷却 ' + left + 's') : '释放';
  }

  function tickCooldowns() {
    var md = GM.currentMap();
    if (!md || md.mode !== 'capture' || !state.capture) { stopCdTimer(); return; }
    var cds = state.capture.cooldowns || {};
    var any = false;
    Object.keys(cds).forEach(function (fid) {
      Object.keys(cds[fid]).forEach(function (sid) {
        var v = Number(cds[fid][sid]) || 0;
        if (v <= 0) return;
        cds[fid][sid] = v - 1;
        setCdButton(fid, sid, cds[fid][sid]);
        if (cds[fid][sid] > 0) any = true;
      });
    });
    if (!any) stopCdTimer();
  }

  function startCdTimer() {
    if (cdTimer) return;
    cdTimer = setInterval(tickCooldowns, 1000);
  }

  function stopCdTimer() {
    if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
  }

  function triggerCommand(md, fid, sid) {
    var c = state.capture;
    if (!c) return;
    var cmd = null;
    (md.commands || []).forEach(function (x) { if (x.id === sid) cmd = x; });
    if (!cmd) return;
    c.cooldowns[fid] = c.cooldowns[fid] || {};
    var left = Number(c.cooldowns[fid][sid]) || 0;
    if (left > 0) {
      GM.ui.toast(cmd.name + ' 冷却中（剩余 ' + left + ' 秒）', 'error');
      return;
    }
    var res = Number(c.resources[fid]) || 0;
    if (res < cmd.cost) {
      GM.ui.toast('资源不足：' + cmd.name + ' 需要 ' + cmd.cost + ' 点，当前 ' + res, 'error');
      return;
    }
    c.resources[fid] = res - cmd.cost;
    c.cooldowns[fid][sid] = cmd.cooldownSeconds;
    buildControls(md);
    renderResult();
    startCdTimer();
    GM.ui.toast(factionById(fid).name + ' 释放「' + cmd.name + '」：' + cmd.effect, 'success');
  }

  function onControlsClick(e) {
    var t = e.target.closest ? e.target.closest('[data-phase-remove], #simAddPhase, #simLoadOwners, #simReadCounts, [data-skill-id], [data-snare-fid], [data-teleport-fid]') : null;
    if (!t) return;
    var md = GM.currentMap();
    if (!md) return;

    if (t.hasAttribute('data-snare-fid') || t.hasAttribute('data-teleport-fid')) {
      if (!state.escort) return;
      var mechFid = t.getAttribute('data-snare-fid') || t.getAttribute('data-teleport-fid');
      var sec = Math.max(0, Math.round(Number(state.escort.mechClockSeconds) || 0));
      var key = t.hasAttribute('data-snare-fid') ? 'snareTimes' : 'teleportTimes';
      var rec = state.escort.mech[mechFid];
      if (!rec) return;
      rec[key].push(sec);
      if (rec[key].length > 50) rec[key].shift();
      buildControls(md);
      renderResult();
      GM.ui.toast('已记录 ' + factionById(mechFid).name + ' ' + (key === 'snareTimes' ? '绊马索' : '集合传送') + ' @ ' + sec + ' 秒', 'success');
      return;
    }

    if (t.hasAttribute('data-skill-id')) {
      triggerCommand(md, t.getAttribute('data-skill-fid'), t.getAttribute('data-skill-id'));
      return;
    }

    if (t.hasAttribute('data-phase-remove')) {
      var idx = Number(t.getAttribute('data-phase-remove'));
      if (state.capture && state.capture.phases.length > 1) {
        state.capture.phases.splice(idx, 1);
        buildControls(md);
        renderResult();
      }
      return;
    }

    if (t.id === 'simAddPhase') {
      if (!state.capture) return;
      var owners = {};
      (md.objectives || []).forEach(function (o) {
        owners[o.id] = state.capture.phases.length
          ? state.capture.phases[state.capture.phases.length - 1].owners[o.id]
          : null;
      });
      state.capture.phases.push({ id: U.uid('simphase'), name: '阶段 ' + (state.capture.phases.length + 1), seconds: 120, owners: owners });
      buildControls(md);
      renderResult();
      return;
    }

    if (t.id === 'simLoadOwners') {
      var plan = GM.activePlan();
      if (!plan || !state.capture) return;
      GM.ensurePlanMeta(plan);
      var first = state.capture.phases[0];
      (md.objectives || []).forEach(function (o) {
        first.owners[o.id] = (plan.scoring && plan.scoring.ownership[o.id]) || null;
      });
      buildControls(md);
      renderResult();
      GM.ui.toast('已按当前守卫归属填充阶段 1', 'success');
      return;
    }

    if (t.id === 'simReadCounts') {
      if (md.mode === 'escort' && state.escort) {
        state.escort.counts = readCircleCounts(md);
        state.escort.followCounts = readCircleCounts(md, state.escort.followRadius);
        var best = null;
        var max = 0;
        primaryFactions(md).forEach(function (f) {
          if ((state.escort.followCounts[f.id] || 0) > max) { max = state.escort.followCounts[f.id]; best = f.id; }
        });
        if (best) state.escort.carrier = best;
        buildControls(md);
        renderResult();
        GM.ui.toast('已读取判定圈 / 跟随圈人数（跟随圆最多 ' + max + ' 人）', 'success');
      } else if (md.mode === 'siege-capture' && state.siege) {
        state.siege.members = readPlatformCounts(md);
        buildControls(md);
        renderResult();
        GM.ui.toast('已读取高台人数', 'success');
      }
    }
  }

  /* ============================ 打开 / 保存 ============================ */

  function setDock(open) {
    var dock = q('#simDock');
    if (!dock) return;
    dock.classList.toggle('is-collapsed', !open);
    var btn = q('#btnSimToggle');
    if (btn) {
      btn.classList.toggle('gold', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (open) syncContext(true);
    else stopCdTimer();
  }

  function openDock() {
    setDock(true);
  }

  function closeDock() {
    setDock(false);
  }

  function saveParams() {
    var plan = GM.activePlan();
    var md = GM.currentMap();
    if (!plan || !md) return;
    GM.ensurePlanMeta(plan);
    plan.sim = plan.sim || {};
    if (md.mode === 'capture') plan.sim.capture = clone(state.capture);
    else if (md.mode === 'escort') plan.sim.escort = clone(state.escort);
    else if (md.mode === 'siege-capture') plan.sim.siege = clone(state.siege);
    else {
      GM.ui.toast('当前地图没有可保存的推演参数', 'error');
      return;
    }
    GM.commit('保存推演参数');
    GM.ui.toast('推演参数已保存到方案「' + plan.name + '」', 'success');
  }

  /* 拖动占领圈结束后调用一次：按新圆心重算判定圈 / 跟随圈人数与归属（不逐帧重算） */
  function syncEscortCircle() {
    var md = GM.currentMap();
    if (!md || md.mode !== 'escort' || !state.escort) return;
    state.escort.counts = readCircleCounts(md);
    state.escort.followCounts = readCircleCounts(md, state.escort.followRadius);
    var best = null;
    var max = 0;
    primaryFactions(md).forEach(function (f) {
      if ((state.escort.followCounts[f.id] || 0) > max) { max = state.escort.followCounts[f.id]; best = f.id; }
    });
    if (best) state.escort.carrier = best;
    buildControls(md);
    renderResult();
  }

  /* ============================ 初始化 ============================ */

  GM.engine = {
    DEFAULTS: DEFAULTS,
    state: state,
    computeCapture: computeCapture,
    computeEscort: computeEscort,
    computeSiege: computeSiege,
    computeClubWar: computeClubWar,
    renderResult: renderResult,
    open: openDock,
    close: closeDock,
    saveParams: saveParams,
    syncEscortCircle: syncEscortCircle,
    init: function () {
      var toggle = q('#btnSimToggle');
      if (toggle) toggle.addEventListener('click', function () {
        var dock = q('#simDock');
        if (dock && !dock.classList.contains('is-collapsed')) closeDock();
        else openDock();
      });

      var closeBtn = q('#btnSimClose');
      if (closeBtn) closeBtn.addEventListener('click', closeDock);

      var saveBtn = q('#btnSimSave');
      if (saveBtn) saveBtn.addEventListener('click', saveParams);

      var controls = q('#simControls');
      if (controls) {
        controls.addEventListener('input', onControlsInput);
        controls.addEventListener('change', onControlsChange);
        controls.addEventListener('click', onControlsClick);
      }

      GM.bus.on('map:changed', function () { syncContext(true); });
      GM.bus.on('change', function () {
        var md = GM.currentMap();
        /* 俱乐部宣战：沙盘点归属 / 面板勾选都会 commit，需同步面板与结果 */
        if (md && md.mode === 'club-war') {
          buildControls(md);
          renderResult();
        }
        syncContext(false);
      });
      GM.bus.on('imported', function () { syncContext(true); });
    }
  };
})();
